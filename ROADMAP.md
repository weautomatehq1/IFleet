# IFleet ROADMAP

> **Reframing note (2026-06-02):** All milestones below describe IFleet's implementation work toward conformance with the canonical pipeline pattern at `~/.claude/skills/CANONICAL-PATTERN.md`. M0-M3 shipped the substrate (Docker verifier, plan-reviewer, KG). M4 (fingerprint + PR-decisions) and beyond are the self-learning hooks the canonical pattern Section 4 requires. M5 (Proposer) and M6 (coherence + routing bandit) are autonomous-mode capabilities the canonical pattern enables.
>
> The previous framing of these milestones as standalone roadmap items remains accurate; this note recontextualizes them against the canonical spec. See `docs/CANONICAL-PIPELINE.md` for the live traceability matrix.

> Six-month elevation plan from "PR-opening task runner" to "autonomous SWE fleet with closed-loop verification, cross-repo intelligence, and goal-driven proposals." Evidence-backed (see `docs/elevation/README.md` for sources).

## North-star metric

**Verifier-passed PRs that get merged on first review, per week.** Today: not measured. Month 1 target: instrument. Month 6 target: ≥10/week across active repos, with verifier↔reviewer disagreement rate <25% (7-day moving average).

## The decision that gates everything

Before any month-1 code: **commit to "single shared trace, specialist roles inside" — explicitly NOT multi-agent.** See `docs/adr/0001-single-trace-architecture.md`. Building month 1's verifier as "a separate agent with its own state" costs three months in untangling.

## Monthly milestones

| Month | Ship | KPI |
|---|---|---|
| **M0 (shipped 2026-05-19, PR #118)** | Eval set, ADR-0001/0002/0003, VerifierAgent scaffold, SECURITY.md, NON_GOALS.md, Operating Standard | Foundation locked, all four canonical spec files exist |
| **M1 ✅ Done (2026-05-20, PRs #130 #135)** | Closed-loop verifier (Docker sandbox + retry loop + Discord). Standing-team daily standup (parallel) | >80% of IFleet PRs pass external CI on first try; daily Discord post live |
| **M2 ✅ Done (2026-05-20, PR #132)** | Plan-Reviewer agent (NOT diff-reviewer — that exists). Renames existing reviewer→diff-reviewer | 20% of plans get reviewer feedback; bugs caught pre-verifier |
| **M3 ✅ Done (2026-05-20, PR #134)** | Cross-repo knowledge graph (tree-sitter + Postgres + pgvector). Architect `query_code_graph` tool | Architect `cost_usd` per task on eval-set replays -30-50% vs M1 baseline |
| **M4** | Behavioral fingerprinting + PR rejection learning (shared `pr_decisions` + `verifier_runs` tables) | 50% of merged PRs have fingerprint diff; reviewer preference cards for top 3 reviewers |
| **M4.5 (Phase C routing migration)** | Update `src/classifier/index.ts` + `config/routing.json` to match canonical correctness-first matrix; remove Phase B Opus cap; write ADR-0004 superseding PR #41 Phase B rationale; remove supersedure note from `docs/MODEL-ROUTING.md` | Classifier output for security/auth/payments/migration matches canonical-pattern Section 3 on the eval set |
| **M5** | Goal-driven mode (Proposer + budget gate + #ifleet-proposals channel) | ≥1 approved+merged proposal/week, 0 noise complaints |
| **M6** | Cross-repo coherence (drift detector) + economic routing (Thompson sampling bandit) | Drift PRs >70% merge rate; cost per task -25% |

## Deferred (gated on eval set + safety constraints)

- **Self-improving IFleet** (Upgrade 10) — IFleet ships PRs to IFleet. Locked until ALL of: (1) `.ifleet/eval/eval-set.jsonl` ≥50 rows, (2) `SECURITY.md` protected paths exist, (3) `docs/elevation/operating-standard.md` signed off, (4) shadow-eval harness exists, (5) `deploy/rollback.sh` documented. See `docs/elevation/upgrades/10-self-improvement.md:9` for current state. Earliest M4.

## Dependency chain

```
M0 (eval set + ADR-0001 + scaffold + SECURITY.md)
  ↓
M1 (verifier) ──┬─→ M2 (plan-reviewer) ─→ M3 (KG) ─→ M4 (fingerprint + PR-learn) ─→ M4.5 → M5 (Proposer) ─→ M6 (coherence + routing)
                └─→ M1.parallel (standing-team rituals — no deps)
                                                    ↓
                                            M4+ (self-improve, gated)
```

## Why this order

- **Verifier first** because every other upgrade benchmarks against "did the PR pass." No verifier = no measurable progress.
- **Plan-Reviewer before KG** because reviewer-veto is cheap to add (prompt-level) and catches bugs the KG would have to architect around.
- **KG before fingerprinting** because fingerprint diffs are useful only when the architect has context-correct plans (KG provides this).
- **Goal-driven mode last** because it produces noise faster than humans can triage if the underlying pipeline isn't reliable.
- **M4.5 inserted because** the canonical pattern at `~/.claude/skills/CANONICAL-PATTERN.md` was authored 2026-06-02 and IFleet's Phase B routing is now policy-superseded. Code alignment can happen any time but should land before M5 ships the Proposer, because the Proposer's recommendations will route through the classifier.

## The one commit to make tomorrow

See `SPRINT.md`. Verifier scaffold (empty Docker shell, ~2h). Forces the contract decision before sunk cost locks in.

## Out of scope for this roadmap

See `NON_GOALS.md`. Notable: no multi-agent fan-out, no per-token cost tracking (flat-rate plans), no client-facing sprint reporter, no Claude Channels (rejected — see CLAUDE.md).

## See also

- `docs/elevation/README.md` — master spec with all 10 upgrade specs cross-linked
- `docs/elevation/impact-on-existing.md` — how this threads into what's already built
- `docs/elevation/eval-set.md` — the private holdout
- `docs/elevation/operating-standard.md` — liability + client-facing rules
- `docs/adr/0001-single-trace-architecture.md` — the load-bearing architectural decision
- `SPRINT.md` — current week's work
