# SPRINT — M0.W1 (Elevation foundation)

> Current sprint. Read `ROADMAP.md` for the 6-month context.

## Sprint goal

Lock the architectural foundation for the 6-month elevation plan **before** any feature code lands. Specifically: the trace-format decision (ADR-0001), the verifier contract shape (empty scaffold), and the eval set (so every later upgrade has a benchmark).

## Why this sprint matters

The 6-month plan has one expensive-to-reverse decision: **single shared trace vs. multi-agent with private contexts.** Cognition's "Don't Build Multi-Agents" (June 2025) and Anthropic's Magentic-One both have strong evidence. Picking wrong costs ~3 months of untangling. This sprint commits to single-trace (Cognition position) with structured-pushback roles inside (MARS pattern).

## In scope (this week)

| ID | Task | Status | Owner |
|---|---|---|---|
| T1 | Write ADR-0001: single-trace architecture | done | seb |
| T2 | Scaffold VerifierAgent (empty Docker shell, emits `verifier.passed` unconditionally) | done | seb |
| T3 | Bootstrap private eval set (50-100 historical tasks, JSONL at `.ifleet/eval/`) | done | seb |
| T4 | Create `SECURITY.md` (protected paths) and `NON_GOALS.md` | done | seb |
| T5 | Write IFleet AI Operating Standard (one-pager, liability) | done | seb |
| T6 | Write ADR-0002: Docker verifier sandbox | done | seb |
| T7 | Write ADR-0003: Knowledge graph stack (tree-sitter + Postgres + pgvector) | done | seb |

## Out of scope (this week)

- Actual verifier logic (M1.W2+)
- Plan-Reviewer (M2)
- Postgres install (M3.W1, gated on T7 ADR approval)
- Self-modifying IFleet (deferred M4+)

## Definition of done

- `docs/adr/0001-single-trace-architecture.md`, `0002-*.md`, `0003-*.md` merged
- `src/agents/verifier/` exists with empty TypeScript shell, types defined, migration file added (verifier_runs + verifier_failures tables), Dockerfile.base scaffolded
- `SECURITY.md` lists protected paths (at minimum: `src/orchestrator/sprint.ts`, `src/queue/`, `src/server.ts`, `.env*`, `deploy/`, `nginx/`, `ecosystem.config.cjs`)
- `NON_GOALS.md` lists the 7+ items from CLAUDE.md and ARCHITECTURE.md out-of-scope sections
- `.ifleet/eval/eval-set.jsonl` exists with ≥10 rows (current realistic ceiling); reach 50 by M3 as sibling repos ship more PRs
- `docs/elevation/operating-standard.md` reviewed and merged

## Verification

- Run `pnpm build` — green
- Run `pnpm test` — green
- `git grep -l "single-trace" docs/adr/` returns ADR-0001
- `wc -l .ifleet/eval/eval-set.jsonl` ≥ 10 (M0.W1 ship gate; ≥50 is the M3 target)

## M1–M3 shipped (2026-05-20)

| Milestone | What landed | Key PRs |
|-----------|-------------|---------|
| M1 | Closed-loop Docker verifier + retry loop + Discord alerts | #130, #135 |
| M2 | Plan-Reviewer agent (renamed diff-reviewer, reviewer catches pre-verifier bugs) | #132 |
| M3 | KG schema + indexer (tree-sitter + Postgres + pgvector core) | #134 |

Canary disagreement alerter also shipped (PR #153).

## Next sprint — Phase 2: 24/7 continuous operation

M1, M2, and M3 are all merged to main. Active work is Phase 2: wiring the fleet for continuous 24/7 operation. See `ROADMAP.md` for M4–M6 dependency chain and `docs/running.md` for single-seat operational policy.
