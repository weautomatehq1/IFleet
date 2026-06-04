# MASTER — 20260603-2338-audit-9fix

## Goal

Close all 9 open findings in `~/.claude/audits/IFleet/index.json` from the post-M4 audit-scan (session `20260603-1245-m4-foundation-plus-obs`). Three parallel worker lanes + a reviewer/merger lane T1.

## Mode

**Strict-mode gated.** Sonnet T1 (orchestrator + per-PR reviewer) + 3 worker lanes. Per-PR review is `/codex-review <PR#>` AND the `verifier` subagent in parallel (every PR closes an `AUDIT-*` finding). Both must PASS to merge.

## Lane map

| Lane | Model | Role | Start | Branch |
|---|---|---|---|---|
| **T1** | Sonnet | Orchestrator + per-PR reviewer | ◆ reviews done-reports as they land | (no branch — review only) |
| **T2** | Sonnet | Session-doc reconciliation (6 findings, IMPORTANT mixed) | ▶ start immediately | `fix/audit-session-doc-reconciliation` |
| **T3** | Sonnet | SqliteNonceLedger TOCTOU fix (1 finding, IMPORTANT, parallel_safe:false) | ▶ start immediately | `fix/audit-nonce-toctou-changes-check` |
| **T4** | Haiku | daemon.ts hygiene + baseRef investigation (2 findings, COSMETIC) | ▶ start immediately | `fix/audit-daemon-hygiene-baseref` |

## Open audit findings (visible to all lanes)

From `~/.claude/audits/IFleet/index.json` (last_updated 2026-06-04T03:33Z, audit-scan id `20260604T032349Z`):

**IMPORTANT (4):**
- `AUDIT-IFleet-318475be` — Reconcile MASTER.md audit-store state — `splits/.../MASTER.md`, `splits/.../T1-done.md`, `.audits/index.json` — **T2 owns**
- `AUDIT-IFleet-ff8c5ce0` — Orphan branch `feat/m4-fingerprint-foundation` on origin + T1-done.md over-claim — `splits/.../T1-done.md` — **T2 owns**
- `AUDIT-IFleet-2bab0c7d` — T1-done.md flag #4 stale (T3 polling bug already fixed in T3.md) — `splits/.../T1-done.md`, `splits/.../T3.md` — **T2 owns**
- `AUDIT-IFleet-63037351` — SqliteNonceLedger TOCTOU — `src/queue/store.ts` — **T3 owns** (parallel_safe:false, own lane)

**COSMETIC (5):**
- `AUDIT-IFleet-9394a64b` — T1-done.md flag #2 stale (M4-T6 already shipped as #316) — `splits/.../T1-done.md` — **T2 owns**
- `AUDIT-IFleet-e11be4c9` — Lane brief boundary should include production wiring — `splits/.../MASTER.md`, `splits/.../T4-done.md` — **T2 owns**
- `AUDIT-IFleet-5b76c1d9` — `wrapFactoryWithVerifierContext` misattributed to factory.ts (lives in daemon.ts:864) — `splits/.../T1-done.md`, `splits/.../T3-done.md` — **T2 owns**
- `AUDIT-IFleet-25ba2f34` — Stale `verdict='abandoned'` doc comment in daemon.ts + 2 test refs — `src/orchestrator/daemon.ts`, `src/queue/__tests__/store.test.ts`, `src/orchestrator/__tests__/daemon-pr-decision.test.ts` — **T4 owns**
- `AUDIT-IFleet-0c47bae9` — Hardcoded `baseRef:'main'` in teardown fingerprint compute (needs verification) — `src/orchestrator/daemon.ts`, `src/agents/verifier/fingerprint.ts` — **T4 owns**

Full finding details in `~/.claude/audits/IFleet/index.json`.

## Gate map

- **No merge gates between worker lanes.** T2, T3, T4 are independent — different file scopes (session docs / `src/queue/store.ts` / `src/orchestrator/daemon.ts` cluster). All three start in parallel.
- T1 reviews each `T<N>-done.md` as it lands; merges per the tiered review chain below.
- The only ordering constraint: T1 must observe T1-done.md from THIS session's T1 (the reviewer), not the earlier `20260603-1245-m4-foundation-plus-obs` session.

## Boundaries — global

- **T2 owns** `splits/20260603-1245-m4-foundation-plus-obs/{MASTER.md,T1-done.md,T3.md,T3-done.md,T4-done.md}` and `.audits/index.json`. T2 may also touch this session's MASTER.md to add a "Lessons" subsection per finding `e11be4c9`.
- **T3 owns** `src/queue/store.ts` (SqliteNonceLedger.registerOrReject body only) and `src/queue/__tests__/control-plane.test.ts` (add the race test). T3 may also touch `SECURITY.md` to amend the "Multi-instance regression risk" paragraph. T3 must NOT touch `pr_decisions` schema or any unrelated code.
- **T4 owns** `src/orchestrator/daemon.ts` (doc comment update + optional `baseRef` threading), `src/orchestrator/__tests__/daemon-pr-decision.test.ts` (header comment update), `src/queue/__tests__/store.test.ts` (LEAVE the `verdict:'abandoned'` assertion as-is per the finding's `fix_sketch` — it's a schema regression guard), and `src/agents/verifier/fingerprint.ts` (no change unless threading baseRef requires it).
- All workers: NO `--no-verify`. NO `--force` push. NO `git add -A`. Branch-protection self-approval workaround per strict-mode rule 8.

## Hold rules

- No specific holds between lanes (they're independent).
- T1 must NOT merge any PR that fails the dual review chain.
- T1 must NOT merge any PR that touches files outside its lane's declared boundary.

## Per-PR review chain (T1)

Every PR in this session closes one or more `AUDIT-*` findings, so all PRs get the dual review chain:

1. `gh pr view <PR#> --json title,body,headRefName,mergeStateStatus,statusCheckRollup,commits`
2. Verify mergeStateStatus=CLEAN, CI green, commit author = `weautomatehq1@gmail.com`
3. Smell-test diff for `console.log` / `TODO` / `FIXME` / `.only(` / commented-out blocks
4. Spawn `/codex-review --pr <PR#>` (subprocess, async)
5. Spawn `verifier` subagent (Task tool, async) with PR diff + the relevant finding JSON pulled from `~/.claude/audits/IFleet/findings/20260604T032349Z.json`
6. Wait for BOTH. Both must return PASS to merge.
7. If either FAIL: comment verdict on the PR via `gh pr comment`, do NOT merge, append to MASTER.md merge log.
8. On PASS: `gh pr comment <PR#> -b "<rationale>"` then `gh pr merge <PR#> --squash --delete-branch --admin`. Append to merge log.

## Verification discipline (before every merge)

- `mergeStateStatus` = `CLEAN` (re-poll on `UNKNOWN`)
- All required CI checks = `SUCCESS`
- Commit author = `weautomatehq1@gmail.com`
- Smell-test the diff
- For T3 (security code): run `pnpm vitest run src/queue/__tests__/control-plane.test.ts` locally and confirm the new race test passes
- For T2 (docs cleanup): confirm the orphan-branch deletion actually executed (`git ls-remote --heads origin feat/m4-fingerprint-foundation` returns empty)

## Polling cadence

T1 polls `splits/20260603-2338-audit-9fix/` every 30–60s for new `T<N>-done.md` files. On each new done-report:
1. Read end-to-end
2. Run the per-PR review chain
3. On PASS+merge, append to MASTER.md "Merge log" and `touch T<N>-REVIEWED`
4. On FAIL, comment the verdict on the PR, append FAIL to merge log, and still `touch T<N>-REVIEWED` (so the poll loop doesn't re-process)

## Merge log

(T1 appends here as PRs land — format: `YYYY-MM-DDTHH:MMZ · T<N> · PR #<num> · <sha> · <verdict>`)

## Stop conditions

- All three workers report done. T1 finishes review chain, writes T1-done.md.
- Any FAIL that the worker lane has not retried 2× → T1-done.md captures the open state.
- Any worker times out (no done-report after 90 min) → T1-done.md records the timeout.

## Session ID

`20260603-2338-audit-9fix`

## Absolute paths

- Session dir: `/Users/Seb/dev/ai-products/IFleet/splits/20260603-2338-audit-9fix/`
- Repo root: `/Users/Seb/dev/ai-products/IFleet/`
- Findings JSON (per-scan, authoritative for verifier subagent): `/Users/Seb/.claude/audits/IFleet/findings/20260604T032349Z.json`
- Index JSON (rollup): `/Users/Seb/.claude/audits/IFleet/index.json`

## Lessons applied (from audit-fix dispatch)

**Production wiring scope — authorize call sites explicitly in lane briefs** (from finding `AUDIT-IFleet-e11be4c9`):

The previous session's MASTER.md scoped T4 to `control-plane.ts` + `nonce-store-*.ts` + `SECURITY.md`, but T4 necessarily had to touch `store.ts`, `server.ts`, and `daemon.ts` to wire the new ledger into the running system. The audit scanner flagged this as a boundary mismatch.

Pattern going forward: when a lane brief authorizes a worker to implement a self-contained feature (e.g., a new persistence layer), the boundary MUST also explicitly authorize the call-site wiring files — i.e., all files where the new code must be imported, instantiated, or passed to existing components. A brief that covers only the implementation files but not the wiring files creates an artificial tension between "stay in scope" and "ship a working feature."

Template language for future MASTER.md lane boundaries:
> `**T<N> owns** <impl-files> AND all call sites required to wire the above into the running system (e.g., <server.ts>, <daemon.ts>, <index.ts>). T<N> must NOT touch <other-lane-files>.`
