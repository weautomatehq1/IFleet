# T1 lane CLEARED — 2026-05-20

T0 finished the audit fixes on `fix/pipeline-worktree-sandboxing`. All forbidden zones from `docs/handoff-2026-05-20-t1-parallel.md` are now open territory again.

## What T0 shipped (one commit, pushed to PR #161)

Commit: `29ff25e` on `fix/pipeline-worktree-sandboxing`

| Audit finding | Status |
|---|---|
| **C2** — fail-loud in `factory.ts:130` (was: silent fallback to `process.cwd()`) | ✅ throws now |
| **I1** — `INTERVIEW_SYSTEM_PROMPT` hardened with ABSOLUTE RULES guard | ✅ |
| **I2** — 8 new regression tests in `src/pipeline/__tests__/worktree-sandboxing.test.ts` covering C2 + 5 stages | ✅ |
| **I3** — investigation: reviewer concerns are NOT persisted (filed as #163) | ✅ filed |
| **I4** — PR #161 body edited to qualify handoff-sourced SHAs | ✅ |
| **I6** — live sprint with `BUDGET_USD=0`, zero `sprint.budget_paused` events observed | ✅ empirically off |

## Final state

- Branch: `fix/pipeline-worktree-sandboxing` @ `29ff25e`, pushed
- PR #161: open with updated body, awaiting CI
- Issue #162 (Max-plan-aware budget cap) — still open, follow-up PR territory
- Issue #163 (reviewer concerns persistence) — NEW, filed during audit
- Tests: **432 vitest + 355 node**, all green
- Daemon: pid 14538, `BUDGET_USD=0`, polling, idle
- Worktree leftovers: `~/.omc/worktrees/task-01KS4W*` and `task-01KS4X*` exist from the two test sprints — safe to leave for now, `teardownWorktree` should clean on next sprint

## All lanes now open

You can:
- Touch `src/pipeline/**` (PR #161 will conflict-resolve at merge time, but minor pipeline edits on a different branch are fine — just rebase if you collide)
- Bounce `pm2 restart ifleet` if you need to test something
- Modify `.env` (but keep `BUDGET_USD=0` until #162 lands)
- Pull on `state/tasks.db`, `~/.omc/ifleet/state.db` freely

## Hot-list (priority order)

1. **Review PR #161** — biggest blocker; everything else stacks on its merge
2. **Pull issue #162** (Max-plan budget) — proper code fix, ~30 min
3. **Pull issue #163** (reviewer concerns persistence) — high-signal observability win
4. **Discord threadId bug** — `[discord-out] postTaskCreated failed: Invalid Form Body` when `messageId` isn't a snowflake — surfaces every time a test task is SQL-injected. Synthetic thread path needs an audit.
5. **`docs/handoff-2026-05-20-worktree-cwd-bug.md`** can move to `docs/archive/` once #161 merges

