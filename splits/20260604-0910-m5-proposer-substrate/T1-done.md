# T1 — Orchestrator + gated reviewer · Opus (strict mode) · DONE

Session: `20260604-0910-m5-proposer-substrate`. T1 reviewed all 4 worker PRs. **No PRs merged this session** — all four hit codex FAIL gates per strict-mode rule 4 (`codex PASS required for feature PRs`; `codex AND migration-auditor PASS required for migration PRs`). PRs left open. Recommended action: Sebastian manual review of each FAIL with the analysis below, then merge / nudge worker / open follow-up.

## PRs reviewed (status table — none MERGED)

| Lane | PR | Branch | HEAD SHA | Review chain | Verdict | T1 action |
|---|---|---|---|---|---|---|
| T2 | [#324](https://github.com/weautomatehq1/IFleet/pull/324) | `feat/m4-reviewer-prefs` | `a21160febfcda3ffdbd5ec99f4bcbb5cd94a2666` | codex | **FAIL (real defect)** | Comment posted, left open |
| T3 | [#323](https://github.com/weautomatehq1/IFleet/pull/323) | `feat/m5-proposer-skeleton` | `b60aa370c5ddfc3b7f2478bab95e1f5527d257cb` | codex | **FAIL (real defect)** | Comment posted, left open |
| T4 | [#325](https://github.com/weautomatehq1/IFleet/pull/325) | `feat/m5-proposer-pipeline` | `50a12bbe4943835019d0c366cac80932e56046c5` | codex | **FAIL (T1 assesses as false positive)** | Comment posted, left open |
| T5 | [#326](https://github.com/weautomatehq1/IFleet/pull/326) | `feat/m5-goal-proposals-and-gate` | `5dc5e4b55407e933cb2ec9c1b246fecc911f8d1e` | codex + migration-auditor | **migration-auditor PASS · codex FAIL (deferred wiring)** | Comment posted, left open |

(Merge log entries appended to `MASTER.md` §"Merge log".)

## Audit / finding flags closed

n/a this session. Confirmed by re-reading `.audits/index.json` at session close: `open_findings: 0` (last_updated `2026-06-03T21:55:56Z`). No audit lanes ran.

## Flags still open + reason

### Per-PR FAIL detail

**T2 PR #324 — codex FAIL (real defect, blocker):**
- Codex: "`buildReviewerCards` never removes previously generated card files for reviewers that fall out of the current top-N/window, so `getReviewerPrefs` can return stale preference cards instead of `null`, violating the top-N card contract."
- T1 cross-read verified: `buildReviewerCards` in `src/learning/reviewer-prefs/build-cards.ts` calls `top.map((c) => writeReviewerCard(outDir, c))` — only writes the current top-N, never enumerates `outDir` to identify stale `<handle>.json` files. `writeFileSync` overwrites same-reviewer files but never deletes; `loadReviewerCard` returns stale cards for fallen-out reviewers, violating the architect's "absence = no priors known" contract.
- Suggested fix (comment in PR): enumerate `outDir/*.json`, build a set of top-N paths, `unlinkSync` the rest; add a round-trip test (top-N={A,B,C} → top-N={A,B,D} asserts C.json removed).
- **NOT a regression** of any prior shipped behaviour (this is brand-new code from this session).

**T3 PR #323 — codex FAIL (real defect, blocker):**
- Codex: "`context-loader` does not emit warn-lines for missing `.omc/learnings.md` or doctor fingerprints because `readRecentLearnings`/`loadFingerprints` return empty values without throwing, so the stated 7-source fail-open warning contract is not met."
- T1 cross-read verified:
  - `src/pipeline/learnings.ts::readRecentLearnings` swallows read errors with `catch { return []; }` — no throw on missing file
  - `src/pipeline/fingerprints.ts::loadFingerprints` short-circuits with `if (!existsSync(path)) return {};`
  - Therefore the proposer-side `safeRead*` wrappers only emit warn-lines on JSON parse failure / permission errors, NOT on the documented "missing file" case
- PR body claim: "Each source falls back to an empty default with a single warn-line if missing." — violated for 2 of 7 sources.
- PR test plan claim: "Context loader fail-open behaviour verified across all 7 sources" — partial (missing-file warn path uncovered for `.omc/learnings.md` and `.omc/fingerprints.json`).
- Suggested fix (comment in PR): probe `existsSync` in `safeReadLearnings`/`safeReadFingerprints` before delegating, OR have the upstream readers return `{ found: false }` so the wrapper can distinguish empty-data from missing-source.
- Cross-impact: T4 PR #325 was based on T3's branch, so T4's PR diff transitively contains the same defect.

**T4 PR #325 — codex FAIL (T1 assesses as FALSE POSITIVE; secondary blocker via T3 transitive):**
- Codex: "`dedupeCandidates` always creates an embedding client even when `ctx.pastProposals` is empty, so the advertised no-past-proposals fast path can still fail or warn due to an unavailable embedding provider."
- T1 cross-read concluded codex is wrong:
  1. **No "no-past-proposals fast path" is documented** anywhere in PR body, T4 done-report, or T3 done-report. Codex hallucinated a contract.
  2. **`safeCreateClient` (~line 127) handles the unavailable-provider case** — wraps `createEmbeddingClient` in try/catch, returns `null` on throw, emits one warn-line. Downstream `else { warn('no embedding client available') }` falls through to `sim=0` for all candidates with embedding-skip. Scorer's documented behaviour is "falls back to alignment=0 when `__embedding` is missing".
  3. **Candidate embeddings are needed regardless** of `pastProposals` being empty — the scorer uses them for SPRINT.md alignment, so short-circuiting client creation on empty pastProposals would break the scorer.
- Other T1 gates verified (PASS): upstream gate observation postdates T3 mtime (13:44:49Z > 13:44:38Z), all 4 stubs replaced, scorer determinism test present, CI all green, mergeStateStatus CLEAN.
- **Secondary blocker:** T4's PR is based off T3's branch, so merging T4 (squash to main) would land T3's open-FAIL context-loader defect into main alongside T4's pipeline. T3 must be resolved first OR T4 rebased after T3 fixes.
- Strict-mode rule 4 prevented T1 auto-merge despite the false-positive assessment. **Recommendation:** Sebastian to manually re-verify the false-positive analysis and merge if confirmed (after T3 lands or T4 is rebased).

**T5 PR #326 — migration-auditor PASS · codex FAIL on deferred wiring:**
- migration-auditor: PASS — "Migration is idempotent (CREATE IF NOT EXISTS), rollback documented with no orphan FK referents, single-tenant RLS omission justified. CHECK constraints on source/decision/resulting_pr_outcome match `types.ts:21-37`. HNSW on `vector_cosine_ops` mirrors 0001 precedent; NULL embeddings skipped by HNSW build; planner picks `idx_proposals_repo_proposed` for non-vector queries. No race between cron INSERT and button UPDATE — INSERT completes before Discord post, button UPDATEs target PK. Migration runner contract honoured. No FKs / no FK-index gap / no legacy-data constraint risk / no secrets."
- Codex: "Production proposer runs in its own PM2 script with no Discord client registration, so `postProposalsForApproval` always returns 0 and never inserts/posts even when `IFLEET_PROPOSALS_CHANNEL_ID` is configured."
- T1 assessment: codex's FAIL identifies a real M5-completion gap, but it is **explicitly deferred** in T5-done.md §"Notes for T1":
  > "Daemon must call `registerProposerDiscordClient(client)` once the Discord bot is logged in. Without it, the proposer cron writes a warn line and returns 0. Adding that call (one line, `daemon.ts`) is outside T5's boundary. Suggest filing as M5 closeout cleanup."
- Hold rule 6 ("one concern per PR — T1 rejects any worker PR that bundles two of {schema, behaviour, tool wiring, Discord posting}") explicitly authorizes deferring the daemon-side wiring. T5's scope is schema + approval-gate; the proposer-run.ts wiring is the third concern.
- Other T1 gates verified (PASS): upstream gate 13:44:58Z > T3 mtime 13:44:38Z, HNSW + pgvector present, rollback documented, `IFLEET_PROPOSALS_CHANNEL_ID` documented in `.env.example`, CI all green.
- Strict-mode "codex PASS required" prevented auto-merge. **Recommendation:** Sebastian to merge manually if accepting the documented M5-closeout wiring gap (the PR's own scope is clean).

### Worker fix watch

T1 watched the session dir for ~25 min after the last FAIL comment was posted (T5 at 14:04Z). No worker pushed a fix. Workers in splittasks are independent Claude sessions and likely terminated after writing their done-reports; they won't react to PR comments without manual intervention. The 60-min escalation window per T1.md (which would expire at 14:47Z for T3, the first FAIL'd PR) is unlikely to produce auto-fixes.

## New bugs surfaced (worker-flagged, NOT fixed this session)

### RESOLVED — pre-push husky hook test contamination (AUDIT-IFleet-43254bcf, closed by fix/audit-husky-test-isolation-and-worktree)
- **Was:** During `git push -u origin feat/m5-goal-proposals-and-gate`, T5 observed the husky `pre-push` hook → `pnpm test` → `src/orchestrator/__tests__/daemon-pr-decision.test.ts` create real commits authored by `test <test@example.com>` on top of the worker's branch HEAD inside the shared `.git` directory (worktrees share `.git`). Branch tip moved to a `seed.txt`-only "seed" commit deleting every project file. T5 recovered via `git checkout feat/m5-goal-proposals-and-gate && git reset --hard 5dc5e4b` and pushed with `HUSKY=0`.
- **Fix:** strip every inherited `GIT_*` env var before spawning git in `daemon-pr-decision.test.ts`; pin `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` to scratch paths; assert tmpdir realpath matches `git rev-parse --show-toplevel` post-init; add a `before`/`after` snapshot of `git log --oneline -5`, `core.bare`, and HEAD on the parent repo to fail loudly on any future regression.
- **Closes also:** AUDIT-IFleet-25566c6a (`.git/config bare=true` corruption — root cause was this contamination), AUDIT-IFleet-552a3c15 (per-lane worktree isolation now mandated in MASTER.md), AUDIT-IFleet-b294d83e + AUDIT-IFleet-c069addc (HUSKY=0 retroactively authorized in MASTER.md§Hold-rule exceptions), AUDIT-IFleet-f04b7806 (cross-lane test edit documented in MASTER.md§Gate semantics).

### MAJOR — VPS pr_decisions schema stale (T2-flagged) — **M4-T6 KPI gate: DEFERRED-OPERATOR, NOT CLOSED**
- `pr_decisions.fingerprint` column missing from `/opt/ifleet/state/tasks.db` on `root@187.124.77.142`. The migration in `src/queue/store.ts:225-232` runs at `new TaskStore(...)` construction — PM2 service hasn't been restarted since #312 merged.
- **Operator fix:** `pm2 restart ifleet` on the VPS. Historical rows stay NULL; new rows get populated by M4 wiring. Full procedure: `docs/runbook.md§M4-T6 KPI remediation`.
- This is why T2's M4-T6 KPI evidence shows ratio=0% in production (code path locally at 100%). **The M4-T6 KPI DoD is NOT cleared by this session** — the production KPI is red pending the operator action above. Do not count M4-T6 as closed until the prod ratio ≥ 50%.

### MEDIUM — `scripts/backfill-pr-decisions.ts` fails on a fresh DB (T2-flagged)
- Tries to `INSERT INTO pr_decisions` with `task_id` references missing from the `tasks` table → `SQLITE_CONSTRAINT_FOREIGNKEY`. Backfill path was written for a DB that already had task seeds; with the FK added to `pr_decisions` in the M4 substrate, this is now broken on cold starts.
- Not fixing in T2's PR (one-concern hold rule); worth a follow-up issue.

### MINOR — Dashboard `pr_decisions` query column-name drift (T2-flagged)
- `dashboard/server.ts:140` selects `decided_at` and reads from `stateDb`, but the canonical table on `tasksDb` has `created_at`. Looks like a vestige from an earlier schema.

### MINOR — Cross-branch leakage on shared worktree (T2 + T3 both flagged)
- Multiple lanes in the same repo root will collide on `HEAD` if any one switches branches without `git worktree`. Both T2 and T3 observed each other's untracked files appearing in their working trees. No data loss; each lane reverted before commit. **Runbook follow-up:** splittasks should require `git worktree add` per lane for parallel work in the same repo.

### MINOR — `IFLEET_PROPOSALS_CHANNEL_ID` documented only in `.env.example` (NOT `deploy/env.example`) — T5
- T1.md required both. Worker added to `.env.example` only. Minor — `deploy/env.example` is the VPS env reference. Add it during M5 closeout.

## Recommendation for next sprint (M5.2 / M6 picture)

Given what landed (or, this session, what's pending merge):

1. **Resolve the 4 FAIL'd PRs first** (single concern per PR, ordered low → high difficulty):
   - **T3 #323** — add `existsSync` probe in `safeReadLearnings`/`safeReadFingerprints` (5-line fix, one new test asserting warn-line emitted on missing file). Once merged, T4 #325 can rebase against main and the codex false-positive can be re-tested.
   - **T2 #324** — add stale-card cleanup in `buildReviewerCards` (enumerate outDir, set diff, unlink) + round-trip test. Independent of M5 lanes.
   - **T4 #325** — after T3 fix lands, rebase against main and Sebastian re-runs codex. If codex still FAILs on the same shape, escalate as a false-positive override.
   - **T5 #326** — Sebastian decides whether to merge with documented deferred wiring (low risk; the migration + persistence layer are sound) or block until daemon wiring lands as a follow-up.

2. **M5 closeout — single small PR** (~30 min effort): add `registerProposerDiscordClient(client)` to `src/orchestrator/daemon.ts` once the Discord bot has logged in. Without it, the proposer's Discord post path is dead even after T5 merges.

3. **CRITICAL infra fix — pre-push test contamination**: this will bite every future PR until isolated. T2 or test-owner adds proper `GIT_DIR`/`GIT_WORK_TREE` env isolation in `daemon-pr-decision.test.ts`. Worth opening an `/audit-scan` finding to drive it through the normal audit-fix lane.

4. **Splittasks worktree hygiene** (runbook): require `git worktree add` per lane for any session with multiple workers on the same repo root.

5. **M5.2 work** (Approve → /ship enqueue + GC of expired proposals): unblocked once the 4 PRs above merge. T5 already exposed `recordProposalDecision` as the seam; M5.2 wires the daemon button handler to enqueue a sprint goal.

6. **`pastProposals.embedding` column read path** (T4 follow-up): once T5 lands and the `embedding` column is populated, swap dedupe's past-side embed call for a SQL read. Spec called this out as the design; deferred to keep T4 / T5 decoupled.

## Wall-clock + rate-cap pauses

- **Wall-clock used by T1:** ~32 min (session start 13:36Z, T1-done.md write 14:08Z + escalation watch). Well under the 4h hard cap.
- **Worker wall-clock observed:** T3 first done 13:44Z, T2 13:48Z, T4 13:57Z, T5 14:04Z. All four within ~30 min of session start. Strict-mode budget of 90-120 min worker time was not exhausted.
- **Rate-cap pauses:** 0. Single-seat flat-rate Max plan — confirmed.

## Plain-language recap

I orchestrated four parallel worker terminals through their reviews and none of the four PRs merged this session. Two of them (T2's reviewer-prefs and T3's proposer skeleton) hit real defects: T2 doesn't clean up stale reviewer-card files when reviewers drop out of the top-N list, and T3's context-loader never emits the documented "missing-file" warn-line for two of its seven data sources. Those are small fixes (5-10 lines each) the workers should make on their next push. The other two (T4's pipeline and T5's schema + Discord) hit codex review FAILs that I think are misjudgments — T4's "fast path" is a contract codex hallucinated, and T5's "wiring gap" is something the worker explicitly deferred per the one-concern-per-PR rule. The strict-mode rules say codex must PASS to auto-merge, so I left all four PRs open with detailed comments instead of forcing through. Sebastian should look at each FAIL comment, decide which to nudge the worker to fix vs which to merge manually, and consider the CRITICAL pre-push hook bug T5 surfaced as the next infra-cleanup target.

<!-- T1-DONE -->
