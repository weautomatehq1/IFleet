---
lane: T3
status: ready-for-review
pr_url: https://github.com/weautomatehq1/IFleet/pull/315
pr_number: 315
branch: feat/m4-record-pr-decision
head_sha: 2d6797f58f2c8cfdaac51edf38b9e258842221c9
upstream_gate_observed_at: 2026-06-04T02:30:08Z
---

## What I built

- **Wired T2's exports into the PR-terminal-verdict call sites.** The
  PR-decision recording happens in `daemon.ts:wireSprintCompletion` —
  SprintManager itself only emits events. T3.md's prose pointing at
  `src/orchestrator/sprint.ts` is misleading; the SprintManager invariant
  ("emits events, never writes to TaskStore") is preserved. The
  existing `daemon-pr-decision.test.ts` already targeted this layer.
- **Two call sites updated** in `wireSprintCompletion`:
  - `sprint.completed` + PR URL → `recordPrDecisionMerged` (async helper) →
    `computeStructuralFingerprint` → `insertPrDecisionWithFingerprint`
    with `verdict='merged'`, `mergedAt=Date.now()`, `fingerprint=<hex|null>`.
  - `sprint.failed` / `sprint.cancelled` + prior PR URL →
    `recordPrDecisionRejected` (async helper) → same compute → same insert
    helper with `verdict='rejected'`. The previous taxonomy used
    `verdict='abandoned'`, which is not in T2's contract. Renamed both
    call sites to `'rejected'` to match the M4 PR-rejection-learning
    semantics (and the verdict triad documented in T2-done.md: `merged |
    rejected | abandoned`).
- **Failure-graceful compute.** New helper `tryComputeFingerprint(ctx)`:
  returns the lowercase-hex sha256 on success, or `null` on any failure
  (missing ctx, missing worktree dir, malformed refs, git non-zero exit).
  Logs a `console.warn` so production failures show up in the daemon
  log without crashing the sprint. The row is still inserted with
  `fingerprint=null` — partial coverage is better than dropping the
  decision entirely.
- **Snapshot-before-evict fix on the cancellation path.** The
  `sprint.cancelled` branch synchronously deletes the verifier-context
  entry inside the same handler turn as the PR-decision insert. The
  initial wire-up read `verifierCtx.get(task.id)` *after* the delete,
  which produced `undefined` and always-NULL fingerprints on cancel.
  Fixed by snapshotting `ctxSnapshot = verifierCtx?.get(task.id)`
  before the eviction runs, so the fingerprint compute sees the
  worktree path that was registered during the pipeline run.
- **Extended `daemon-pr-decision.test.ts` to five integration cases.**
  Each test boots a real tmp git repo (`git init -b main`, seed commit,
  feature branch with a new file) so the production `git diff --numstat`
  path runs end-to-end — no mocks. A `pollForRows` helper waits up to
  2 s for the fire-and-forget compute+insert chain to land before
  asserting.
  - **Case 1** — `sprint.completed` + PR URL + live worktree → exactly
    one row with `verdict='merged'`, `mergedAt > 0`, `fingerprint` is a
    64-char hex sha256.
  - **Case 2** — `sprint.failed` + prior PR URL + live worktree → one
    row with `verdict='rejected'` + fingerprint hex (renamed from the
    pre-T5 `'abandoned'` expectation).
  - **Case 3** — `sprint.failed` without any PR URL → no row written
    (unchanged graceful-skip behaviour).
  - **Case 4** — `sprint.cancelled` + prior PR URL + live worktree →
    one row with `verdict='rejected'` + fingerprint hex (also renamed).
    This case fails without the snapshot-before-evict fix above.
  - **Case 5** — `sprint.completed` + PR URL + `verifierCtx` whose
    `worktreePath` does NOT exist → one row with `verdict='merged'`,
    `fingerprint=NULL`. Proves the failure-graceful contract.

## Files touched

- `src/orchestrator/daemon.ts` — new imports (`randomUUID`,
  `computeStructuralFingerprint`), new helpers `tryComputeFingerprint`
  / `recordPrDecisionMerged` / `recordPrDecisionRejected`, two
  `wireSprintCompletion` call sites rewritten to use the M4-T2 helpers,
  cancellation-path snapshot fix.
- `src/orchestrator/__tests__/daemon-pr-decision.test.ts` — converted
  to async tests, added tmp git repo fixture, added a polling helper
  for the fire-and-forget compute chain, added the compute-fail case,
  updated verdict assertions to `'rejected'`.

## Test results

- `pnpm tsc --noEmit` — clean (exit 0).
- `node --import tsx --test src/orchestrator/__tests__/daemon-pr-decision.test.ts` — 5/5 pass.
- `node --import tsx --test 'src/orchestrator/__tests__/**/*.test.ts'` — 113/113 pass.
- `node --import tsx --test 'src/queue/**/*.test.ts'` — 138/138 pass.
- Pre-push hook ran the wider vitest suite during `git push` — 684/684 pass.

## Smoke caveats

- **Production-timing caveat.** In the live pipeline,
  `bootstrap.teardown` (in `wrapFactoryWithVerifierContext` →
  `teardownWorktree` in `src/orchestrator/daemon.ts:864`) runs BEFORE
  `task.completed` and `sprint.completed` events fire, and removes the
  worktree directory and deletes the local branch. That means the
  fingerprint compute at the `wireSprintCompletion` call site will most
  often see a missing `worktreePath` in production and fall back to
  `fingerprint=NULL`. T3's prose treats that as graceful-degradation
  ("a fingerprint compute failure should NOT crash the sprint — log a
  warning and insert the row with fingerprint: null"), and the row IS
  recorded with the verdict, so PR-rejection learning still gets the
  merge/reject signal. To actually populate fingerprints on the merged
  KPI ("50% of merged PRs have fingerprint diff" — ROADMAP M4), a
  follow-up should move the compute to teardown time
  (before `teardownWorktree` removes the directory) and stash the hex
  on the `TaskContextRecord` for the `wireSprintCompletion` handler to
  read. That refactor was out of scope for T3 ("call site" wording) —
  flagging here for T1 to decide whether to bundle into this PR or open
  a follow-up issue.
- **Test exercise is the tmp-git-repo path, not the real pipeline.**
  Real GitHub merge / reject events arriving at the daemon are not
  exercised — the tests simulate the orchestrator event bus directly.
  The production compute path uses the same code as the test path
  (real `git diff --numstat` against a worktree), so the contract
  surface is covered, but the production-pipeline-end-to-end run
  belongs in M4-T6 or a smoke test, not here.
- **No mock for the fingerprint compute.** Tests use a real tmp git
  repo per T3's "(or use a tiny tmp git repo) so the test is
  deterministic" guidance — easier to audit than a mock, and the
  fingerprint hash bytes match what production would compute on the
  same diff.

## Notes for T1

- **Review focus**:
  - (a) **Failure path inserts row with NULL fingerprint.** Case 5 in
    `daemon-pr-decision.test.ts` is the regression test — point a
    worktreePath at a nonexistent dir, expect `fingerprint=null` plus a
    `[daemon] computeStructuralFingerprint failed:` log line. The
    `tryComputeFingerprint` helper is the wrapping point; never throws.
  - (b) **Idempotency — second merge event for same PR doesn't
    double-insert.** Backed by the existing `UNIQUE INDEX
    idx_pr_decisions_task_pr ON pr_decisions(task_id, pr_number)` from
    T2's schema + `INSERT OR IGNORE` inside
    `insertPrDecisionWithFingerprint`. No new test was added for this
    here; T2's `pr-decisions-fingerprint.test.ts` already covers the
    UNIQUE-constraint dedup directly against the helper. The wireup
    layer doesn't add a new dedup mechanism.
  - (c) **Cancellation-path snapshot bug.** The `ctxSnapshot` line in
    the `sprint.failed | sprint.cancelled` branch is load-bearing —
    without it, the `verifierCtx?.delete(task.id)` on cancellation
    wipes the registry entry before `tryComputeFingerprint` reads it,
    and Case 4 in the test would fail with `fingerprint=null` instead
    of a hex hash. Discovered during initial test run; fix is the
    `const ctxSnapshot = verifierCtx?.get(task.id)` line at the top
    of the branch.
  - (d) **Verdict rename: `abandoned` → `rejected`.** sprint.failed
    and sprint.cancelled paths with an open PR now write
    `verdict='rejected'` instead of `'abandoned'`. T2's `PrVerdict`
    union still includes `'abandoned'`; nothing actively writes it
    after this PR. T3.md explicitly asks for `verdict='rejected'` in
    the test for close-without-merge, and the M4 PR-rejection learning
    keys off `rejected`. If T1 disagrees with the rename, the
    alternative is reverting to `'abandoned'` here and adding a
    separate "actual GitHub PR rejection" event handler later —
    flagging the decision rather than hiding it.
- **Cross-check**: `gh pr diff 315` is the source of truth — 2 files,
  ~385 insertions / ~167 deletions; clean review surface.
- **Boundary compliance**: no edits to `src/queue/store.ts`,
  `src/agents/verifier/fingerprint.ts`, `src/queue/control-plane.ts`,
  or `docs/adr/`. No force-pushes.

## Worktree

T3 ran directly on `/Users/Seb/dev/ai-products/IFleet` (no isolated
worktree) — left untouched per BEGIN block ("Do NOT run
`git worktree remove` — T1 handles cleanup after merge").
