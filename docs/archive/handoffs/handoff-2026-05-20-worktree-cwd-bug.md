# IFleet Handoff — 2026-05-20 (Worktree CWD Bug Investigation)

Technical handoff for the Opus session picking up the worktree-cwd bug after the earlier session closed.

---

## 1. What was accomplished in the previous session

### Auth fix (MERGED — PR #158, commit fa4aa6b on main)
- `src/workers/claude-env.ts`: added `USER` and `LOGNAME` to `CLAUDE_ENV_ALLOWLIST`
- Without these, macOS Security framework can't find the "Claude Code-credentials" keychain entry
- Claude subprocesses now authenticate correctly via the Max-plan OAuth token

### Daemon boot fixes (PR #160 OPEN — branch `fix/daemon-boot-recovery`)
Two bugs fixed in `src/orchestrator/daemon.ts`:

1. **`recoverStale()` never called at boot** — `TaskStore.recoverStale()` resets stuck `in_flight` tasks back to `pending`. It was only called in `server.ts`, not `daemon.ts`. Tasks stuck from a previous crash stayed `in_flight` forever without manual intervention.

2. **Double-dispatch on restart** — After a crash, if a task was `in_flight` and then reset to `pending` by `recoverStale()`, while `StateStore` still had a `running` sprint for that task, `resumeAbandoned()` recovered the old sprint AND `runTickLoop` created a new sprint → two architect subprocesses for the same task. Fixed by cancelling all `running` StateStore sprints before the `Orchestrator` constructor runs (which is where `resumeAbandoned()` is called).

**PR #160 is green, tests passing (425/425). It needs to be merged.**

---

## 2. The worktree-cwd bug — root cause investigation (INCOMPLETE)

### Symptom
After sending a test task, the **main repo's branch was switched** to `feat/add-version-helper` by the IFleet agent. The task completed successfully (code was written, branch pushed to origin), but the agent operated in the main repo instead of the sandboxed worktree.

### Evidence
From `git reflog` on the main repo:
```
HEAD@{7}: commit ac556db  "feat: add readVersion() helper"   ← commit in MAIN repo
HEAD@{6}: reset: moving to HEAD~1                            ← undo of that commit
HEAD@{5}: checkout: moving from main to feat/add-version-helper
HEAD@{4}: commit b80ebe1  "feat: add readVersion() helper"   ← re-commit after branch switch
```

All these events are in the **main repo's** reflog, not in a separate worktree. This confirms the agent ran in `/Users/Seb/dev/IFleet`, not `/Users/Seb/dev/IFleet/.omc/worktrees/task-01KS4VTEST000000001IFLEET`.

PM2 log DID show the correct worktree path in the editor log line:
```
[pipeline] editor starting model=claude-sonnet-4-6 worktree=/Users/Seb/dev/IFleet/.omc/worktrees/task-01KS4VTEST000000001IFLEET
```

But the reflog contradicts this — the commits landed in main repo. **Either** the `cwd` was wrong **or** the architect (which runs before the editor) committed in the main repo and the editor later ran in the worktree on top of that.

### Pipeline architecture (critical context)

There are **two separate adapter layers** in this codebase — this caused confusion during investigation:

**Layer 1 — Pipeline layer** (`src/workers/types.ts`)
- `WorkerAdapter.spawn(opts: SpawnOpts)` where `SpawnOpts.workingDir: string` (required)
- Used by `src/pipeline/factory.ts::buildWorkerPool`
- The active adapter is `createClaudeCliPipelineAdapter()` → `createClaudeAdapter()` (from `src/workers/claude.ts`)
- `claude.ts` correctly passes `cwd: opts.workingDir` to the subprocess
- This layer IS used by the architect/editor/reviewer pipeline stages

**Layer 2 — Orchestrator layer** (`src/orchestrator/types.ts`)
- `WorkerAdapter.spawn(taskId, brief, opts: SpawnOpts)` where `SpawnOpts` = `{ model?, permissionMode?, timeoutMs? }` — NO `workingDir`
- Used by `SprintManager` for dispatching tasks at the orchestrator level
- Registered via `src/workers/adapters/claude-cli.ts` → `createClaudeCliAdapter()`
- This adapter captures `workingDir` from **static constructor opts** (not per-spawn)

**The `buildWorkerPool.spawn()` in `factory.ts` (line 130):**
```typescript
const workingDir = opts.worktreePath ?? resolve('.');
// 'opts.worktreePath' is from PipelineSpawnOpts (pipeline layer)
// 'resolve(".")' = daemon's cwd = main repo
```

The key question: **is `opts.worktreePath` populated for ALL pipeline stages?**

### What each pipeline stage passes as worktreePath

| Stage | Passes `worktreePath`? | Runs in |
|---|---|---|
| Architect (`architect.ts:97`) | **NO** | `resolve('.')` = main repo |
| Architect retry (`architect.ts:184`) | **NO** | main repo |
| Editor (`editor.ts:42-46`) | **YES** — `worktreePath: input.worktreePath` | worktree ✓ |
| Plan-reviewer (`plan-reviewer.ts:202`) | unknown | ? |
| Diff-reviewer (`diff-reviewer.ts:89`) | unknown | ? |
| Doctor (`doctor.ts:81`) | unknown | ? |

**The architect runs in the main repo.** For a simple task with no architect system-prompt guard, the Claude subprocess may implement the feature directly rather than just planning — especially if `WORKER_INSTRUCTION` says "execute the task brief" without an architect-specific override.

### Where to look next

1. **`src/pipeline/architect.ts` lines 85-105** — check what `systemPrompt` is passed to the architect spawn. Does it say "produce a plan" or "execute the task"? The `WORKER_INSTRUCTION` in `claude.ts` line 12-18 says "Execute the user-supplied task brief" — this applies to ALL workers unless overridden by `systemPrompt`.

2. **`src/pipeline/plan-reviewer.ts`, `diff-reviewer.ts`, `doctor.ts`** — check whether they pass `worktreePath` in the spawn opts. If not, they also run in the main repo.

3. **Possible fix A**: Pass `worktreePath: input.worktreePath` in architect's spawn call. This would sandbox the architect in the worktree too, preventing any accidental writes to the main repo.

4. **Possible fix B**: The architect system prompt should explicitly say "OUTPUT ONLY A PLAN. Do not write or commit files. Do not use git." This prevents the architect from going rogue even if it runs in the main repo.

5. **Possible fix C**: Both — sandboxed worktree AND constrained system prompt. Belt-and-suspenders.

### Files to read first
- `src/pipeline/architect.ts` — full file, focus on system prompt and spawn call
- `src/pipeline/plan-reviewer.ts` — check spawn call worktreePath
- `src/pipeline/factory.ts` lines 65-135 — the full factory setup

---

## 3. Current system state

| Item | State |
|---|---|
| Daemon (`ifleet` PM2) | Running clean, no active tasks |
| PR #160 | Open, green, needs merge |
| Branch `fix/daemon-boot-recovery` | Ready to merge |
| Branch `feat/add-version-helper` | Pushed to origin (agent's output), not merged |
| StateStore (`~/.omc/ifleet/state.db`) | Clean — all sprints `failed`/`cancelled` |
| Unified queue (`state/tasks.db`) | One `done` task, one `failed` test task (fake Discord ID) |
| Main repo branch | On `fix/daemon-boot-recovery` |
| Tests | 425/425 passing |
| TypeScript | 0 errors |

---

## 4. Immediate next steps (ordered)

1. **Merge PR #160** (`fix/daemon-boot-recovery`):
   ```bash
   gh pr merge 160 --squash --delete-branch
   git checkout main && git pull --rebase origin main
   pm2 restart ifleet --update-env
   ```

2. **Root-cause the worktree-cwd bug** — read `src/pipeline/architect.ts` fully. Determine if architect passes `worktreePath` to spawn, and what system prompt it uses.

3. **Fix architect sandboxing** — either add `worktreePath: input.worktreePath` to architect's spawn call, or add a strong "plan only, no writes" system prompt guard, or both.

4. **Audit other pipeline stages** — check plan-reviewer, diff-reviewer, doctor spawn calls for missing `worktreePath`.

5. **Verify fix** — send another test task, run `lsof -p <architect-pid> | grep cwd` during execution to confirm cwd = worktree, not main repo.

---

## 5. Hard rules (do not break)

- **DO NOT use `ANTHROPIC_API_KEY`** — system runs on Claude Pro Max OAuth via macOS keychain. `USER` and `LOGNAME` must be in `CLAUDE_ENV_ALLOWLIST` (already fixed).
- `SprintManager` emits events; it NEVER calls GitHub directly (CLAUDE.md load-bearing rule).
- Branch protection on `main` — always via PR, never direct push.
- Editor model floor = Sonnet (never Haiku).
- Single-seat Max-plan — never spawn parallel Claude sessions sharing quota.

---

## 6. Key file index

| Path | Purpose |
|---|---|
| `src/orchestrator/daemon.ts` | Daemon boot — `recoverStale()` + sprint cancellation fixes (PR #160) |
| `src/workers/claude-env.ts` | `CLAUDE_ENV_ALLOWLIST` — `USER`+`LOGNAME` added (merged) |
| `src/pipeline/factory.ts` | `buildWorkerPool.spawn()` — `workingDir = opts.worktreePath ?? resolve('.')` |
| `src/pipeline/architect.ts` | **NEXT TARGET** — architect spawn call and system prompt |
| `src/pipeline/editor.ts` | Editor correctly passes `worktreePath: input.worktreePath` |
| `src/workers/claude.ts` | `WORKER_INSTRUCTION` — "Execute the task brief" (applies to all workers) |
| `src/workers/adapters/pipeline-registry.ts` | Pipeline adapter registry — `createClaudeCliPipelineAdapter` |
| `~/.omc/ifleet/state.db` | StateStore SQLite |
| `state/tasks.db` | Unified queue TaskStore |
| `docs/handoff-2026-05-20.md` | Previous session handoff (auth fix + recordPrDecision) |
