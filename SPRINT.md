# SPRINT — M0.W1 (Elevation foundation)

> Current sprint. Read `ROADMAP.md` for the 6-month context.

## Sprint goal

Lock the architectural foundation for the 6-month elevation plan **before** any feature code lands. Specifically: the trace-format decision (ADR-0001), the verifier contract shape (empty scaffold), and the eval set (so every later upgrade has a benchmark).

## Why this sprint matters

The 6-month plan has one expensive-to-reverse decision: **single shared trace vs. multi-agent with private contexts.** Cognition's "Don't Build Multi-Agents" (June 2025) and Anthropic's Magentic-One both have strong evidence. Picking wrong costs ~3 months of untangling. This sprint commits to single-trace (Cognition position) with structured-pushback roles inside (MARS pattern).

## In scope (this week)

| ID | Task | Status | Owner |
|---|---|---|---|
| T1 | Write ADR-0001: single-trace architecture | pending | seb |
| T2 | Scaffold VerifierAgent (empty Docker shell, emits `verifier.passed` unconditionally) | pending | seb |
| T3 | Bootstrap private eval set (50-100 historical tasks, JSONL at `.ifleet/eval/`) | pending | seb |
| T4 | Create `SECURITY.md` (protected paths) and `NON_GOALS.md` | pending | seb |
| T5 | Write IFleet AI Operating Standard (one-pager, liability) | pending | seb |
| T6 | Write ADR-0002: Docker verifier sandbox | pending | seb |
| T7 | Write ADR-0003: Knowledge graph stack (tree-sitter + Postgres + pgvector) | pending | seb |

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

## Next sprint (M1.W2)

Verifier becomes real: parse `pnpm test` / `pnpm build` output into structured `verifier_failures` rows, emit `verifier.failed` with structured payload, re-queue to editor with max-3 retry. See `docs/elevation/upgrades/01-verifier.md`.
