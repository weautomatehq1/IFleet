# MASTER — 20260604-1224-audit-fix-m5-aftermath

> **Mode:** strict gated · audit-fix multi-tag PRs (codex + verifier per lane) · Opus on T2, Sonnet on T3/T4, Haiku on T5
> **Project:** IFleet (`/Users/Seb/dev/ai-products/IFleet`) · branch `main`
> **Source:** `/audit-fix AUDIT-IFleet-... (×19)` — dispatches the 19 new findings emitted by the 16:08Z `/audit-scan` over `20260604-0910-m5-proposer-substrate`
> **Audit store:** `~/.claude/audits/IFleet/index.json` (canonical; NOT `<repo>/.audits/`)

## Goal

Close out all 19 new audit findings emitted by `/audit-scan` over the M5-proposer-substrate session. Dispatch them across 4 worker lanes per the audit-triager subagent output. T1 reviews + merges each AUDIT-* PR after both Claude verifier and codex PASS (or arbiter MERGEs on disagreement).

## Pre-dispatch repair

The orchestrator already executed AUDIT-IFleet-25566c6a's fix sketch — `git config core.bare false` in the IFleet working tree — and switched HEAD from `feat/m4-reviewer-prefs` back to `main`. Without this, every worker's `git rev-parse --show-toplevel` would have failed and the lanes could not have started. T2 verifies and amends the session-doc record.

## Lane assignments

| Lane | Role | Model | Audit IDs (count) | Start |
|---|---|---|---|---|
| **T1** | Orchestrator + per-PR reviewer | Sonnet | n/a | ◆ after workers land done-reports |
| **T2** | Infra: git-bare + husky test contamination + worktree isolation | **Opus** | 25566c6a · 43254bcf · 552a3c15 · b294d83e · c069addc · f04b7806 (6) | ▶ immediately · MUST merge first |
| **T3** | M5 proposer wiring + context-loader fail-open + scope/override seams | Sonnet | 5d05d2c2 · 190aa774 · 247fbfd5 · e6437823 · a857ce71 (5) | ▶ immediately |
| **T4** | M4-T6 KPI remediation: fingerprint coverage + backfill cold-start | Sonnet | 49af4d80 · 31181042 · 665d9f3c (3) | ▶ immediately |
| **T5** | Session-doc reconciliation + trivial cosmetics | Haiku | 87ddb83f · 1eec5580 · 9787dcf4 · d7f01321 · 87fa6403 (5) | ▶ immediately |

## Sequencing constraint

T2 MUST merge first — its fixes restore .git/config sanity, isolate the husky pre-push test, and mandate per-lane `git worktree add`. Without T2 on main, the husky hook will keep contaminating subsequent worker pushes (each lane will need its own `HUSKY=0` workaround, which is exactly what T2 is removing).

T3/T4/T5 PRs all touch `MASTER.md` and `T1-done.md` of the upstream session (`20260604-0910-m5-proposer-substrate`). T1 must merge serially T2 → T3 → T4 → T5 with rebases between each so the markdown conflicts stay trivial.

## Hold rules

1. **No `--no-verify`, no `--force` push, no `git add -A`.** Period. (T2's job is to make this satisfiable by fixing the husky pre-push test isolation; until then, `HUSKY=0` is an emergency-only escape and MUST be recorded as a hold-rule exception in this MASTER.md§"Hold-rule exceptions" subsection at the bottom.)
2. **All worker PRs must pass `pnpm tsc --noEmit && pnpm test` locally before push.** T1 re-verifies via CI before merge.
3. **Multi-tag PRs allowed** — each PR closes multiple findings via `[audit-fix:AUDIT-IFleet-<id>]` tags in title/body. Closure writer matches tags individually.
4. **One concern per lane** — the lanes are concept-clustered (infra, M5 wiring, M4 KPI, doc reconciliation) but multi-tag-per-lane is intentional because the findings within a lane share file_globs.
5. **Sequencing:** T2 first, then T3 → T4 → T5 with serial rebases.

## Hold-rule exceptions

(T2 will add the b294d83e/c069addc HUSKY=0 retrospective exception here once its branch lands.)

- `2026-06-04 · T3 · HUSKY=0 push of fix/audit-m5-wiring-and-context-loader · reason: T2 not yet merged; husky pre-push test contamination (AUDIT-IFleet-43254bcf) still active; local pnpm tsc --noEmit + pnpm test verified clean before push · resolved-by: T2's PR (fixes AUDIT-IFleet-25566c6a/43254bcf)`

## Per-PR review chain

Per audit-fix v4 (verifier subagent + /codex-review + arbiter):
1. T1 pre-rebase via `audit-prereview-rebase.sh` if mergeStateStatus is DIRTY (allowlist: `.env.example`, `.gitignore`, `package.json`, `pnpm-lock.yaml`, `.audits/*.json`).
2. T1 dispatches `verifier` subagent with PR diff + first finding title from the PR body. Stdout's first line is the Claude verdict.
3. T1 spawns `/codex-review --pr <PR#> --goal "(see PR body)"` — codex evaluates against the multi-tag PR body, NOT individual finding titles (per `/codex-review` skill §"Goal scope — pass the PR body").
4. T1 arbitrates via `audit-arbiter.sh <PR#> "$CLAUDE_VERDICT" "$CODEX_VERDICT" --finding-id <one-id-from-tags> --repo weautomatehq1/IFleet`:
   - `MERGE` (exit 0): `gh pr merge <PR#> --squash --delete-branch --admin`
   - `LEAVE-OPEN` (exit 1): `gh pr comment <PR#> -b "<verdicts>"`, leave open
   - `ESCALATE` (exit 2): comment with both verdicts + "arbiter cannot disambiguate; human review required", leave open
   - codex UNAVAILABLE → Claude-only merge with banner comment
   - codex FAIL but Claude verifier PASS → LEAVE-OPEN by default. **Exception (false-positive override):** if a human reviewer has added the PR label `codex-override` or posted a comment `codex-FAIL-acknowledged-by:<github-handle>` citing the specific FAIL line as a hallucination, the arbiter may treat the codex vote as PASS for that PR. The override must be logged here in §"Hold-rule exceptions" with the cited FAIL text and the human attesting it is a false positive.

## Verification discipline (T1 before merge)

- mergeStateStatus == CLEAN (re-poll on UNKNOWN)
- All required CI checks SUCCESS
- Commit author = weautomatehq1@gmail.com
- gh pr diff: no `console.log`, no TODO/FIXME, no `.only(`, no commented-out blocks
- Each `[audit-fix:AUDIT-IFleet-<id>]` tag in the PR body matches an `id` in `~/.claude/audits/IFleet/index.json` with status=fixing

## Merge log

T1 appends to this section as merges happen:

```
<ISO> · T<N> · <PR#> · <status> · <SHA> · <merged-finding-count>
```

(empty until first merge)

## Pre-authorized actions (no further consent)

- `--dangerously-skip-permissions` on every lane (T2-T5 + T1)
- T1's autonomous `gh pr comment`, `gh pr merge --squash --delete-branch --admin`
- Terminal.app window titles via osascript
- `git config core.bare false` (already executed by orchestrator)

## Reference docs (lanes load as needed)

- Each lane's T<N>.md handoff document (in this session dir)
- `~/.claude/audits/IFleet/index.json` — finding source of truth
- `~/.claude/audits/IFleet/findings/20260604T160834Z.json` — immutable per-scan snapshot
- Upstream session: `splits/20260604-0910-m5-proposer-substrate/{MASTER.md,T1-done.md,T2-done.md,T3-done.md,T4-done.md,T5-done.md}`
- `~/.claude/CLAUDE.md` — global rules

## Wall-clock budget

Estimated 60-90 min worker time (T2 has the most surface; T3 has 5 findings; T4 has 3; T5 mostly markdown). T1 review chain: ~15 min per PR × 4 PRs = 60 min. Hard cap 4h.
