# M5 Proposer — module layout

Voyager-pattern goal proposer. One nightly run per repo. Single trace, no fan-out (ADR-0001).
Spec: `docs/elevation/upgrades/06-goal-driven.md`.

## File ownership (split 20260604-0910-m5-proposer-substrate)

| File | Owner | Purpose |
|---|---|---|
| `types.ts` | T3 | Shared contract — every cross-lane type lives here. **Stable surface.** |
| `index.ts` | T3 | `runProposer()` — orchestration entry point. Stage seams for tests. |
| `context-loader.ts` | T3 | Fail-open loader: SPRINT/ROADMAP/NON_GOALS/learnings/fingerprints/pr_decisions/past_proposals. |
| `candidate-gen.ts` | T4 | Haiku call producing `Candidate[]` from `ProposerContext`. **Stubbed by T3.** |
| `dedupe.ts` | T4 | Cosine-similarity dedup against last 30d. **Stubbed by T3.** |
| `scorer.ts` | T4 | Attaches `sprint_alignment` + `composite_score`. **Stubbed by T3.** |
| `budget.ts` | T4 | Sorts by score, slices to `min(budget, hardMax)`. **Stubbed by T3.** |
| `approval-gate.ts` | T5 | Writes `goal_proposals` rows + posts Discord buttons. **Stubbed by T3.** |
| `__tests__/` | T3 (skeleton) + T4 / T5 (extend) | Orchestration + fail-open tests; T4/T5 add module-level tests. |

## Stub strategy

T3 ships every file above so `pnpm tsc --noEmit` passes from day one. The T4/T5 modules throw
`Error('Lane T<N> not landed yet …')` from a single exported function — when T4 or T5 lands,
their PR diff REPLACES the stub body (not adds a new file). This keeps the orchestrator's
imports stable and the merge clean.

## Cron entry

`scripts/proposer-run.ts` is the PM2 one-shot cron wrapper (see `ecosystem.config.cjs`,
entry `ifleet-proposer`). Gated on `PROPOSER_ENABLED=1` — off by default until T4 and T5
land. Reads `PROPOSER_REPO_ID` (or `PROPOSER_REPO_IDS` comma-list) for the repo(s) to scan.
