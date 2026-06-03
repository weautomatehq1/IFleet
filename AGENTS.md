# AGENTS.md — IFleet

> Conventions for AI coding agents (Codex, Claude, Cursor, Aider, Gemini, Copilot, others)
> operating on IFleet's own source. Claude Code reads `CLAUDE.md` in this directory
> directly — this file exists so non-Claude agents get the same conventions.
>
> **Before starting work, also read:**
> - `CLAUDE.md` (this repo root) — mandatory rules + architecture invariants
> - `NON_GOALS.md` (this repo root) — permanent vs. revisitable rejections
> - `docs/ARCHITECTURE.md` — 4-role pipeline, components, source layout
> - `docs/MODEL-ROUTING.md` — current Phase B routing (superseded — see below)
> - `~/.claude/CLAUDE.md` — org-wide Claude rules
> - `~/.claude/skills/CANONICAL-PATTERN.md` — the cross-implementation spec this repo aligns to

## What this is

Autonomous-mode implementation of the canonical pipeline pattern. Picks up GitHub Issues
from target repos, splits work to the right model, runs Architect → Plan-Reviewer →
Editor → Diff-Reviewer pipeline, opens draft PRs after CI passes. PM2-managed on
Hostinger VPS. Single-seat Max-plan policy (see `CLAUDE.md` mandatory rule 1).

This is internal infrastructure for weautomatehq1 — open source for transparency, not
sold. See `NON_GOALS.md` for explicit out-of-scope items.

## Stack

- Language: TypeScript via `tsx` (no build step)
- Runtime: Node 20+
- Package manager: `pnpm@10.33.2`
- Tests: `pnpm test` (vitest + node:test)
- Typecheck: `pnpm tsc --noEmit`
- Lint: `pnpm lint`
- Other useful scripts: `pnpm start`, `pnpm start:control-plane`, `pnpm dashboard`,
  `pnpm eval:replay`, `pnpm graph:migrate`, `pnpm graph:index`, `pnpm channels:health`

## Verify before claiming done

All three exit 0 BEFORE opening any PR:
1. `pnpm tsc --noEmit`
2. `pnpm test`
3. `pnpm lint`

For classifier or routing changes: add at least one test case to `src/classifier/__tests__/`
covering the new behavior. For pipeline changes: run `pnpm eval:replay` on a relevant
brief to verify no regression on the eval set.

"Should work" is not done. Demonstrated green is done.

## Don't touch without explicit instruction

- `.env`, `.env.*` — secrets including `BUDGET_USD`, Discord tokens, Anthropic/OpenAI keys
- `pnpm-lock.yaml` — regenerate via `pnpm install`, never hand-edit
- `config/routing.json` — affects every fleet dispatch; needs review per task
- `src/queue/github.ts` — must NOT directly call GitHub. The architecture rule
  (`CLAUDE.md` load-bearing): SprintManager emits events; GitHub interactions flow
  through the queue bridge layer. Refuse PRs that bypass the bridge.
- The Phase B cap in `src/classifier/index.ts` — superseded by canonical pattern
  Section 3 (correctness-first), but only removed in tracked Phase C migration
  (ROADMAP M4.5). Don't remove ad-hoc — the supersedure is policy; the code change
  has its own sprint.
- `ecosystem.config.cjs` — PM2 production config; touches need review
- VPS path `~/arca/` and any PM2 entry named `arca` — friend's project hosted on the
  same VPS, off-limits. Route around any port/path conflict, never displace.
- Git history rewrites — no `--force`, no `--no-verify`, no `git reset --hard`, no
  `git add -A`

## Commit style

- Format: `<type>(<scope>): <imperative summary>` — e.g., `fix(classifier): respect complexity:high on auth keywords`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- For PRs closing an audit finding, include `AUDIT-<id>` in title or body so the
  closure mechanism can attribute it (matters for `closed.json` ClosureRecord)
- Stage specific files by name. Never commit `.env` or any secret.

## Deeper context

- `CLAUDE.md` — mandatory rules, skills auto-load, project-specific
- `NON_GOALS.md` — what IFleet is NOT (permanent vs. build-time)
- `docs/ARCHITECTURE.md` — 4-role pipeline + Source layout
- `docs/MODEL-ROUTING.md` — Phase B policy (supersedure header notes the
  canonical replacement)
- `docs/CANONICAL-PIPELINE.md` — traceability matrix between canonical spec and
  IFleet implementation
- `docs/adr/` — load-bearing architectural decisions (ADR-0001 single-trace,
  ADR-0003 KG + symbolic)
- `SPRINT.md` — current sprint context
- `ROADMAP.md` — M0-M6 plan + M4.5 Phase C migration
- `~/.claude/skills/CANONICAL-PATTERN.md` — the spec

## Project-specific notes

- **Within-task fan-out is rejected** (ADR-0001). Multi-persona debate agents are
  superseded by the Plan-Reviewer (M2). Cross-task parallelism (multiple Issues
  running concurrent sprints) is in scope.
- **Cross-provider review is load-bearing.** Diff-Reviewer is "the opposite
  provider" — Claude editor ↔ Codex reviewer, or vice versa. Do not collapse
  to single-provider review chains.
- **Editor must be Sonnet floor — never Haiku for editing code** (mandatory rule 3,
  matches canonical-pattern routing Section 3).
- **Closed audits whose fixes must not regress:** see `.audits/closed.json`.
  Recent ones (2026-06-02 batch) include PM2 timezone handling, GITHUB_TOKEN
  passthrough in ecosystem config, ifleet-canary/retro tsx invocation, and PM2
  log routing for ifleet-standup + doctor-scan.
- **Discord briefs go to `#ifleet`** (channel id `1504120127791042631`), never
  `#general`.
