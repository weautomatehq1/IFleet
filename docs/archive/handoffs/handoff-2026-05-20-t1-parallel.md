# T1 parallel terminal handoff — 2026-05-20 (audit fixes in flight)

Seb, this is your safe workspace while the Opus terminal (T0) closes the audit findings on `fix/pipeline-worktree-sandboxing`.

---

## What T0 is doing right now (DO NOT TOUCH)

Branch: `fix/pipeline-worktree-sandboxing` (PR #161)

Files T0 will edit:
- `src/pipeline/factory.ts` — adding fail-loud guard for missing `worktreePath`
- `src/pipeline/interview.ts` (or wherever `INTERVIEW_SYSTEM_PROMPT` lives) — appending ABSOLUTE RULES guard
- `src/pipeline/prompts.ts` — possibly cross-referenced
- `src/pipeline/__tests__/*.test.ts` — adding spawn-opts spy tests for architect/plan-reviewer/diff-reviewer/haiku-gate/doctor
- New test file possibly under `src/pipeline/__tests__/worktree-sandboxing.test.ts`
- PR #161 body (via `gh pr edit 161`)

Runtime T0 will touch:
- `pm2 logs ifleet` (read only)
- One inserted row in `state/tasks.db` for live BUDGET_USD verification (ID `01KS4XTEST*`)
- Read-only queries to `~/.omc/ifleet/state.db` to inspect reviewer concerns

**Do not** restart pm2 `ifleet`, do not modify `.env`, do not switch the daemon's branch.

---

## Safe lanes for T1

Branch off `main`, **not** off `fix/pipeline-worktree-sandboxing`:
```bash
git fetch origin main && git checkout -b <your-branch> origin/main
```

### Open territory (touch freely)

| Lane | Paths | Notes |
|---|---|---|
| **Discord control plane polish** | `src/queue/sources/discord.ts`, `src/control-plane/**` | Today's sprint surfaced `postTaskCreated failed: Invalid Form Body` when `messageId` isn't a snowflake — there's a real bug there: HTTP-control-plane tasks need synthetic thread creation (PR #157 partially addressed). Search `markFailed failed: no Discord threadId` in logs. |
| **Dashboard** | `dashboard/` (untracked) | Whatever you were building there — totally isolated from pipeline work. |
| **Docs / ROADMAP** | `docs/**`, `SPRINT.md`, `ROADMAP.md`, `ARCHITECTURE.md` | Don't touch `docs/handoff-2026-05-20-worktree-cwd-bug.md` (T0's reference). |
| **Orchestrator (non-daemon)** | `src/orchestrator/store.ts`, `src/orchestrator/sprint.ts` (read), `src/orchestrator/types.ts` | T0 won't touch these; safe to refactor. **Avoid** `src/orchestrator/daemon.ts` until T0 confirms the live test is done (~10-15 min). |
| **Knowledge graph / KG** | `src/kg/**`, `src/agents/rituals/**` | Untouched lanes. |
| **Issue triage** | GitHub issues, labels, PR review (not #160/#161) | Read-only on PR #161 — let T0 finish before reviewing. |

### Forbidden zones until T0 reports done

- `src/pipeline/**` — all five files. T0 owns this until merge.
- `src/orchestrator/daemon.ts` — T0 may bounce pm2 to pick up new code; collisions cause confusion.
- `.env` — T0 will not modify further this session, but the `BUDGET_USD=0` line is load-bearing for the live test. Don't strip it.
- `state/tasks.db` — T0 inserting one row for live verification. Don't bulk-insert or wipe.
- `~/.omc/ifleet/state.db` — T0 querying for reviewer evidence; reads only.
- `~/.omc/worktrees/` — T0 may inspect, do not `git worktree remove`.

---

## Coordination signals

When T0 is done you'll see one of:
- A comment from T0 on PR #161 OR
- A new commit on `fix/pipeline-worktree-sandboxing` and a Discord brief OR
- This file replaced with `docs/handoff-2026-05-20-t1-cleared.md` (T0 will write it)

If T0 stalls or you need to merge `main` urgently, ping in chat — don't force a branch switch.

---

## Open backlog you could pull from (sized for a parallel session)

1. **Issue #162 spec deep-dive** — Read it, decide A/B/C, but **don't implement yet** (`src/orchestrator/sprint.ts` is borderline; safer to wait until T0's branch lands so the diff is clean).
2. **Discord threadId bug** — Reproducible from today's sprint logs. New PR off main.
3. **`docs/handoff-2026-05-20-worktree-cwd-bug.md` archive** — Move to `docs/archive/` once PR #161 merges. Skip for now (don't move before merge).
4. **Dashboard work** — whatever was in flight pre-audit.
5. **Voice-AI Factory umbrella work** — `~/dev/coordination/factory/` is a separate repo; fully isolated.

---

## Current snapshot

- Branch (T0): `fix/pipeline-worktree-sandboxing` @ `62d2d9e`
- PR #161: open, green
- PR #160: merged (`be50f10` on main)
- Issue #162: open, awaiting recommendation
- Daemon: pid 14538, `BUDGET_USD=0` in env, polling every 5s
- Tests: 424 vitest + 355 node (will go up after T0 adds I2 coverage)

