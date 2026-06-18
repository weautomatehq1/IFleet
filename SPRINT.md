# SPRINT — M5.2 (Approve → /ship enqueue) + M6 prep

> Current sprint. Read `ROADMAP.md` for the 6-month context.

> **Status update (2026-06-17):** M5.2 + M6 substrate have **shipped** — Approve→/ship
> enqueue, PR-outcome tracking, M6 drift-scan cron, triple shadow signal, M4.6 mode-override
> realignment, retro generator, and the flag-gated M6 closure paths (`DRIFT_REAL_PR`,
> `BANDIT_LIVE`, both default OFF) are all merged. The in-sprint task table below is
> historical. An audit-hardening sweep also landed (#374–#386, 15 findings incl. 6 CRITICAL
> security) — see `docs/runbooks/audit-hardening-2026-06.md` for the deploy-affecting changes.
> Remaining gates are operator/prod-signal bound: M5 live deploy (`#ifleet-proposals` channel
> + `PROPOSER_ENABLED=1`) and the M6 live flips (`DRIFT_REAL_PR`/`BANDIT_LIVE`).

## Sprint goal

M5 substrate landed 2026-06-15 across #323/#325/#326 (proposer skeleton + types contract, candidate-gen/dedupe/scorer/budget, goal_proposals schema + Discord HITL gate). Today the Approve button persists a decision to `goal_proposals` and stops — it does NOT yet trigger a sprint. M5.2 closes that loop so an approved proposal becomes a real sprint goal end-to-end.

In parallel, scope M6 (cross-repo coherence drift detector + Thompson sampling bandit routing) into landable lanes so it can ship right after M5.2 deploys.

## Why this sprint matters

M5's substrate is dead weight until Approve → /ship is wired. Without M5.2 there is no way for an approved proposal to leave the table — every nightly run accumulates decided rows with no downstream effect. M5.2 is the smallest change that turns the entire M5 surface from "demo" into "production-useful."

M6 prep is concurrent because the substrate is independent of M5 deploy state: a drift detector reads cross-repo KG data (M3) and bandit routing reads M4's `pr_decisions` table — neither needs M5 to be live.

## In scope (this sprint)

| ID | Task | Status | Owner |
|---|---|---|---|
| M5.2-T1 | Wire Approve button → /ship enqueue. Approve handler emits a `sprint_goal` ControlCommand with the proposal title as the goal text and `resulting_task_id` written back to the `goal_proposals` row when the task spawns. | **shipped** ([#351](https://github.com/weautomatehq1/IFleet/pull/351)) | fleet |
| M5.2-T2 | Resulting PR outcome tracking: on PR merge/close from a proposal-spawned task, write `resulting_pr_url` + `resulting_pr_outcome` back to `goal_proposals`. Feeds Voyager iterative-prompting loop. | **shipped** ([#352](https://github.com/weautomatehq1/IFleet/pull/352)) | fleet |
| M5.2-T3 | Deploy gate: `pnpm graph:migrate` on VPS; create #ifleet-proposals + set `IFLEET_PROPOSALS_CHANNEL_ID` + `IFLEET_PROPOSALS_APPROVER_IDS`; `pm2 restart all --update-env`; enable `PROPOSER_ENABLED=1`. | **script merged** ([#355](https://github.com/weautomatehq1/IFleet/pull/355)); VPS deploy pending | fleet+seb |
| M6-T1 | Drift detector skeleton: cross-repo coherence scan over the M3 KG. Reads stable signatures across repos and flags rename/deletion/signature-change pairs. Output: candidate drift PRs (one per source-of-truth repo). | **shipped** ([#353](https://github.com/weautomatehq1/IFleet/pull/353)) | fleet |
| M6-T2 | Thompson sampling bandit routing: per-model success/cost posterior, sample-once-per-task to pick the model. Reads `pr_decisions.verdict` for reward signal. Read-only shadow mode for the first 100 tasks. | **shipped** ([#354](https://github.com/weautomatehq1/IFleet/pull/354)) | fleet |

## Out of scope (this sprint)

- Self-modifying IFleet (deferred — see NON_GOALS.md)
- Mode override realignment (M4.6/M4.7/M4.8 — ADR-0004 §Known limitations)
- New eval-set tasks (held until shadow-mode bandit produces signal)

## Definition of done

- Approve button on a proposal opens a PR within one sprint cycle (no manual `/ship` step required).
- `goal_proposals.resulting_pr_outcome` populated for at least one merged PR-from-proposal.
- VPS has #ifleet-proposals live, `PROPOSER_ENABLED=1`, and at least one nightly run posted candidates.
- M6 drift detector substrate landed (skeleton + tests). PR open or merged.
- M6 bandit routing substrate landed in shadow mode (read-only — does NOT yet override the routing decision).
- `pnpm test` green, `pnpm tsc --noEmit` clean.

## Verification

- `SELECT count(*) FROM goal_proposals WHERE resulting_task_id IS NOT NULL` > 0 after first approved proposal.
- `SELECT count(*) FROM goal_proposals WHERE resulting_pr_outcome IS NOT NULL` > 0 after first PR closure from a proposal.
- `grep -r 'drift-detector' src/` returns the M6 skeleton.
- `grep -r 'bandit' src/agents/` returns the shadow-mode bandit module.

## M0–M5 shipped

| Milestone | What landed | Key PRs |
|-----------|-------------|---------|
| M0 | ADR-0001/0002/0003, VerifierAgent scaffold, SECURITY.md, NON_GOALS.md, eval set | #118 |
| M1 | Closed-loop Docker verifier + retry loop + Discord alerts | #130, #135 |
| M2 | Plan-Reviewer agent (renamed diff-reviewer, catches pre-verifier bugs) | #132 |
| M3 | KG schema + indexer (tree-sitter + Postgres + pgvector core) | #134 |
| M4 | Behavioral fingerprinting + reviewer preference cards | #324 (substrate predates this; #324 closes M4-T3/T4/T6) |
| M4.5 | Phase C routing migration on scorer + routing.json | (PR ref in ADR-0004) |
| M5 | Goal-driven mode substrate: proposer skeleton, candidate pipeline, goal_proposals schema, Discord HITL gate | #323, #325, #326 |

Canary disagreement alerter shipped via `feat/canary-disagreement-alerting` (07b5781).

## Next sprint — M6 closure + Voyager loop

Once M5.2 has produced at least one full proposal → PR cycle and M6 shadow signal exists, M6 closure ships: drift detector → real PRs (gated on >70% merge rate); bandit routing flipped from shadow to live (gated on cost-per-task -25%). See `ROADMAP.md` for the dependency chain.

**Note:** M4.5 (Phase C routing migration) scoped-ship 2026-06-03 — `src/classifier/index.ts` aligns with the canonical correctness-first routing matrix on the scorer + routing.json rule paths. See [ADR-0004](docs/adr/0004-canonical-routing-alignment.md) for the superseding decision and the M4.6/M4.7/M4.8 follow-ups (mode/category/severity paths). M5 Proposer routes through the classifier without inheriting the retired Phase B cap, with operator awareness that `mode:tdd`/`ulw`/`ralph`/`deslop` can still downshift a canonical-Opus assignment until M4.6 lands.
