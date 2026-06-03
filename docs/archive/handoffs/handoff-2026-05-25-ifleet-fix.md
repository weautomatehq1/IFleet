# IFleet Fix Handoff — 2026-05-25

## Status at handoff
- **IFleet is STOPPED** on VPS (`pm2 stop all`). Safe to work.
- `better-sqlite3` native bindings: **fixed** (rebuilt for Node v24.15.0)
- Audit findings Supabase store: **partially built, needs rebase** (see §3)

---

## What was burning tokens (root cause found)

The smoke runner polls GitHub every 5 minutes for issues labeled `auto:ship`.
Issues **#70, #72, #75** had that label. The pipeline ran (architect + editor = tokens burned) but PRs failed because of a `--reviewer @monstersebas1` bug in the old code.

Because the PR never opened, the issue was never closed, so the smoke runner picked it again 5 minutes later. **Infinite loop burning tokens with nothing to show.**

The `--reviewer` bug is **already fixed** in the current codebase (PR #183 separated reviewer assignment from `gh pr create`). But the smoke loop risk remains if a pipeline fails after a PR opens — issues only auto-close when PRs are **merged**, not just opened.

---

## Three things to fix before restarting

### Fix 1 — Smoke loop guard (CRITICAL)
After the smoke runner picks an issue, it must remove the `auto:ship` label (or add `in_progress`) so a failed run doesn't re-queue the same issue.

**Where:** `scripts/run-smoke.ts` — find `pickNext` / label assignment logic.
**Fix:** After picking an issue, call `gh issue edit <number> --remove-label "auto:ship" --add-label "ifleet:in_progress"`. On completion (PR opened), add `ifleet:done`. On failure, add back `auto:ship` only after a cooldown.

### Fix 2 — Discord task completion ping (IMPORTANT)
Tasks complete silently. There's no Discord message when a PR opens. Seb has no visibility.

**Where:** `src/orchestrator/daemon.ts` around line 395-410 — the pipeline completion block.
**Fix:** After `openPipelinePr` succeeds, call `out.postToChannel(channelId, "✅ PR opened: <url>")`. The `DiscordOut` instance exists at that point. Look at how `out.postProgress` is called for the `picked up` message and mirror the pattern.

### Fix 3 — Audit store rebase (IMPORTANT)
This session built a Supabase audit store (`src/audit/audit-store.ts`, updated `src/audit/audit-handler.ts`). But VPS is on commit `a15b07d` which **deleted** `audit-handler.ts` entirely and moved all audit logic into `src/discord/handlers/interaction-create.ts`.

**The new `audit-store.ts` is sound** — just needs to be re-wired to the new file locations.

**Steps:**
1. Read `src/discord/handlers/interaction-create.ts` — find the audit read/write points
2. Import `dbReadIndex`, `dbUpsertFindings`, `dbUpdateFindingStatus` from `src/audit/audit-store.ts`
3. Replace local file reads with `dbReadIndex(repo)` (try Supabase, fallback to file)
4. After each scan completion, call `dbUpsertFindings(openFindings, repo)`
5. After each fix completion, call `dbUpdateFindingStatus(id, 'closed', { closing_pr, closed_at })`
6. Fix the repo key mismatch: always use `ctx.repo` (the full `weautomatehq1/IFleet` form), NOT `repoPath.split('/').pop()`. Findings in Supabase use `IFleet` (basename), Discord uses `weautomatehq1/IFleet`. Pick one and use it everywhere.
7. Add partial unique index to migration: `CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_fp_repo_active ON audit_findings (fingerprint, repo) WHERE status != 'closed';`

### Also: kill cron restart schedules
The cron jobs (audit-nightly, audit-morning, ifleet-canary, ifleet-standup, ifleet-retro) have registered schedules that will auto-restart overnight even while stopped. Either delete their entries or add `autorestart: false` until IFleet is stable.

```bash
ssh root@187.124.77.142 "pm2 delete ifleet-audit-nightly ifleet-audit-morning ifleet-canary ifleet-standup ifleet-retro"
```

---

## Restart checklist (do in order)
1. ✅ `better-sqlite3` rebuilt
2. Fix smoke loop guard (Fix 1)
3. Add Discord completion ping (Fix 2)
4. Rebase audit store (Fix 3)
5. `pnpm tsc --noEmit` — must be clean
6. `pnpm test` — must be green
7. Kill cron jobs on VPS
8. `pm2 start ifleet` only — leave others stopped
9. Send one test task via Discord, watch for completion ping

---

## Key files
| File | Role |
|---|---|
| `scripts/run-smoke.ts` | Smoke runner — Fix 1 here |
| `src/orchestrator/daemon.ts` | Pipeline loop — Fix 2 here |
| `src/discord/handlers/interaction-create.ts` | New home for audit handlers — Fix 3 here |
| `src/audit/audit-store.ts` | Supabase store — keep, re-wire |
| `deploy/postgres/0002-audit-findings.sql` | Run via `pnpm graph:migrate` — covered by the standard runner |
| `config/channels.json` | Channel → repo → codeowners mapping |
| `/opt/ifleet/.env` | VPS env — `IFLEET_KG_DATABASE_URL` now set |

## Supabase audit findings
- Table `audit_findings` created and **has 102 findings** seeded from Mac
- `IFLEET_KG_DATABASE_URL` is set in VPS `.env`
- Sync script: `pnpm audit:sync` (Mac → Supabase)
- Stop hook auto-syncs after local `/audit-scan`
