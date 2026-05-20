# IFleet Elevation Plan — Master Spec

> Evidence-backed 6-month plan to turn IFleet from "PR-opening task runner" into "autonomous SWE fleet with closed-loop verification, cross-repo intelligence, and goal-driven proposals."

## How to read this directory

| File | Purpose |
|---|---|
| `README.md` (this file) | Master overview, the 7 ceiling items, the 3 priority upgrades, the dependency chain |
| `impact-on-existing.md` | How this plan threads into IFleet's existing `src/verify/`, `pipeline/reviewer.ts`, `learnings.ts`, `doctor-scan.ts`, etc. |
| `eval-set.md` | The private holdout — bootstrapping + maintenance + why it matters more than SWE-Bench Verified |
| `operating-standard.md` | Liability one-pager for client-facing work |
| `upgrades/01-*.md` to `upgrades/10-*.md` | Per-upgrade specs (architecture, data model, Discord interface, failure modes, order) |

## The 7 ceiling items (from previous Opus analysis, validated against research)

1. **Linear pipeline with no reflection** → addressed by Upgrade 2 (Plan-Reviewer with structured veto)
2. **No closed-loop verification** → addressed by Upgrade 1 (Docker sandbox verifier)
3. **Flat memory** → addressed by Upgrade 3 (cross-repo knowledge graph)
4. **No shared world model** → addressed by Upgrade 3
5. **No self-model** → addressed by Upgrade 8 (economic routing learns per task type per repo)
6. **No architectural invariants** → addressed by Upgrade 1 invariant integration (Semgrep + ArchUnitTS in `.ifleet/invariants/`)
7. **Goal-driven continuous mode missing** → addressed by Upgrade 6 (Proposer + budget gate)

## The 10 upgrades (ordered by build order)

| # | Upgrade | Month | KPI |
|---|---|---|---|
| 1 | [Closed-loop verifier](upgrades/01-verifier.md) | M1 | >80% PRs pass external CI first try |
| 2 | [Plan-Reviewer agent](upgrades/02-plan-reviewer.md) | M2 | 20% of plans get reviewer feedback |
| 3 | [Cross-repo knowledge graph](upgrades/03-knowledge-graph.md) | M3 | Architect `cost_usd` per task -30-50% vs M1 baseline |
| 4 | [Behavioral fingerprinting](upgrades/04-fingerprinting.md) | M4 | 50% of merged PRs labeled `breaking: true/false` |
| 5 | [PR rejection learning](upgrades/05-pr-learning.md) | M4 | Reviewer preference cards for top 3 reviewers |
| 6 | [Goal-driven mode](upgrades/06-goal-driven.md) | M5 | ≥1 approved+merged proposal/week |
| 7 | [Cross-repo coherence watcher](upgrades/07-coherence.md) | M6 | Drift PRs >70% merge rate |
| 8 | [Economic routing bandit](upgrades/08-economic-routing.md) | M6 | Cost per task -25% |
| 9 | [Standing-team rituals](upgrades/09-standing-team.md) | M1 (parallel) | Daily Discord standup live |
| 10 | [Self-improving IFleet](upgrades/10-self-improvement.md) | M4+ (gated) | Match/beat baseline on eval set |

## The load-bearing decision (made in M0, see ADR-0001)

**Single shared trace with specialist roles, NOT multi-agent with private contexts.**

- Cognition's "Don't Build Multi-Agents" (June 2025) argues isolated context = drift.
- Anthropic's Magentic-One + MetaGPT argue structured pushback catches bugs.
- **Synthesis (what we build):** SprintManager owns the canonical trace. Architect / Plan-Reviewer / Editor / Diff-Reviewer / Verifier / Indexer / Proposer are **roles inside that trace** — they read the trace, write to the trace, no private memory. Plan-Reviewer can veto with structured `[reasons]` (MARS Author→Reviewer→Meta pattern). This is Cognition-aligned but keeps the bug-catching benefit Anthropic identified.

The expensive-to-reverse part is the **trace format**:
- Append-only JSON event log per task
- Persisted: SQLite (existing `store.ts`) + S3-compatible blob (Hostinger has this) for full transcripts
- Each role's input = `(trace_so_far, role_specific_prompt)`
- `learnings.md` is **derived** from traces nightly, never edited directly

## Three questions Sebastian hasn't asked (answers)

### 1. What's the evaluation set?

You don't have one. SWE-Bench Verified is contaminated (87.6% Opus 4.7 / 88.7% GPT-5.5 vs. ~53% on SWE-Bench Pro for the same models). You need 50-100 real historical tasks from your own repos, frozen as a private holdout. Every upgrade benchmarks against it. See `eval-set.md`.

### 2. Who is liable when IFleet ships a bug to production?

Devin runs sandboxed with HITL merge approval. Copilot Workspace requires human approval before push. For WeAutomateHQ on client repos, this is existential. See `operating-standard.md`.

### 3. What's the canary that IFleet is getting worse?

Best leading indicator: **verifier↔reviewer disagreement rate**. When the internal verifier passes things a human reviewer rejects, the verifier is missing what the world now cares about. Alert at 7-day moving average >25%. This is IFleet's SLO. Instrumented from day one of M1.

## Source-cited evidence base

The architecture choices in this plan are grounded in:

- **Reflexion** (arxiv 2303.11366) — reflection loops add +18.5pp
- **OpenHands** (docs.openhands.dev) — Docker sandbox event-stream pattern, agent-environment interface
- **AutoCodeRover** (github.com/AutoCodeRoverSG) — AST-aware search beats string match, 46.2% on Verified at <$0.7/task
- **RepoGraph** (arxiv 2410.14684, ICLR 2025) — graph-based retrieval +32.8% across frameworks
- **Codebase-Memory** (arxiv 2603.27277) — tree-sitter + KG: 83% answer quality at 10× fewer tokens
- **MARS** (arxiv 2509.20502) — Author→Reviewer→Meta matches multi-agent debate at ~50% fewer tokens
- **Voyager** (arxiv 2305.16291) — automatic curriculum + skill library pattern (ports directly to repos)
- **Spotify Honk Part 3** (engineering.atspotify.com, Dec 2025) — strong feedback loops differentiate background agents that work from ones that spam
- **SICA** (arxiv 2504.15228, ICLR 2025) — self-improving agent pattern (with weak guardrails; our M0.U8 adds AGrail-style constraints)
- **AgentAssay** (arxiv 2603.02601) — behavioral fingerprinting catches 86% regressions where binary pass/fail catches 0%
- **Cognition Devin 2025 Review** (cognition.ai/blog) — 67% PR merge rate, 10-14× speedup on file-level legacy migrations
- **Don't Build Multi-Agents** (news.smol.ai/issues/25-06-13) — Walden Yan / Cognition; canonical context-engineering position

## Next steps

1. Read `SPRINT.md` for this week's tasks
2. Read `ADR-0001` for the trace-format decision before any code lands
3. Read `impact-on-existing.md` to understand what each upgrade replaces vs. extends
4. Run `gh issue list --state closed --limit 200` across repos to start the eval set bootstrap
