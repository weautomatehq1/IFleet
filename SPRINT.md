# SPRINT — M4 (Behavioral fingerprinting + PR rejection learning)

> Current sprint. Read `ROADMAP.md` for the 6-month context.

## Sprint goal

Build behavioral fingerprinting for PRs and a rejection-learning loop so IFleet can stop repeating patterns that human reviewers reject. M1–M3 delivered the verifier, plan-reviewer, and knowledge graph; M4 wires them together with memory.

## Why this sprint matters

Without fingerprinting, IFleet has no way to learn from reviewer feedback across sprints. Every rejection is siloed. M4 adds a shared `pr_decisions` table (merged/rejected + fingerprint diff), reviewer preference cards, and a feedback loop so the architect can adapt its plans based on what reviewers historically approve.

**Canonical-pattern alignment:** M4's fingerprinting + `pr_decisions` table is IFleet's implementation of canonical-pattern Section 4 ("Self-learning hooks"). The manual pipeline implements the same pattern via `closed.json` fingerprints + `audit-rule-drafter.sh`. After M4 ships, the unified port (sharing logic between the two implementations) becomes possible — tracked separately as a post-M4 work item.

## In scope (this sprint)

| ID | Task | Status | Owner |
|---|---|---|---|
| M4-T1 | Schema: `pr_decisions` + `verifier_runs` tables with fingerprint column | open | fleet |
| M4-T2 | Fingerprinting: compute structural diff hash for each PR at merge/reject time | open | fleet |
| M4-T3 | Reviewer preference cards: per-reviewer accept/reject pattern summary (top 3 reviewers) | open | fleet |
| M4-T4 | Architect tool `get_reviewer_prefs` — queries preference cards before planning | open | fleet |
| M4-T5 | `RecordPrDecision` event emitted by SprintManager on PR merge or close-without-merge | open | fleet |
| M4-T6 | 50% of merged PRs have fingerprint diff populated (KPI validation) | open | fleet |

## Out of scope (this sprint)

- Goal-driven mode / Proposer (M5)
- Cross-repo drift detector (M6)
- Thompson sampling bandit routing (M6)
- Self-modifying IFleet (deferred — see NON_GOALS.md)

## Definition of done

- `pr_decisions` and `verifier_runs` tables migrated and deployed to KG database
- Fingerprinting runs on every SprintManager close event (merged + rejected)
- Reviewer preference cards populated for top 3 reviewers in `.ifleet/prefs/`
- Architect emits `query_reviewer_prefs` tool call in ≥50% of observed plan cycles
- `pnpm test` green, `pnpm tsc --noEmit` clean

## Verification

- `SELECT count(*) FROM pr_decisions WHERE fingerprint IS NOT NULL` > 0 after first post-M4 sprint
- Reviewer preference card JSON exists at `.ifleet/prefs/<reviewer>.json`
- `grep -r "get_reviewer_prefs" src/` returns the architect tool definition

## M0–M3 shipped (2026-05-20)

| Milestone | What landed | Key PRs |
|-----------|-------------|---------|
| M0 | ADR-0001/0002/0003, VerifierAgent scaffold, SECURITY.md, NON_GOALS.md, eval set | #118 |
| M1 | Closed-loop Docker verifier + retry loop + Discord alerts | #130, #135 |
| M2 | Plan-Reviewer agent (renamed diff-reviewer, catches pre-verifier bugs) | #132 |
| M3 | KG schema + indexer (tree-sitter + Postgres + pgvector core) | #134 |

Canary disagreement alerter shipped via `feat/canary-disagreement-alerting` (07b5781).

## Next sprint — M5: Goal-driven mode

Once M4 fingerprinting is validated (≥50% fingerprint coverage, preference cards live), M5 ships the Proposer: autonomous goal generation + #ifleet-proposals channel + budget gate. See `ROADMAP.md` for M5–M6 dependency chain.

**Note:** M4.5 (Phase C routing migration) shipped 2026-06-03 — `src/classifier/index.ts` now aligns with the canonical correctness-first routing matrix. See [ADR-0004](docs/adr/0004-canonical-routing-alignment.md) for the superseding decision; M5 Proposer can route through the classifier without inheriting the retired Phase B cap.
