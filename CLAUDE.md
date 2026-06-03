# CLAUDE.md — IFleet

> Autonomous agent fleet. Claude Code + Codex workers shipping PRs 24/7. Public repo, branch-protected, single-seat Max-plan.

This repo inherits global rules from `~/.claude/CLAUDE.md`. Single-seat operational policy lives in `docs/running.md`.

**Umbrella context:** `weautomatehq1/factory` is the master coordination repo for "The Factory" — voice-AI interview → 17-file spec → IFleet builds → self-heals. Read `~/dev/coordination/factory/ARCHITECTURE.md` for the system-of-systems view across Factory + IFleet + voice-discovery + spec-template + per-client repos. This repo's docs cover **IFleet-internal detail only**. Cross-repo milestones live in `factory/ROADMAP.md` with bracketed `[M-NNN]` IDs; gap issues opened in this repo should be labeled `epic:M-NNN` to link back.

## Relationship to canonical pipeline

IFleet implements the canonical pattern at `~/.claude/skills/CANONICAL-PATTERN.md`. Where this doc and the canonical spec conflict, the canonical spec wins and the conflict is a bug to file (label: `realign:<area>`).

The routing policy in `docs/MODEL-ROUTING.md` is the canonical correctness-first matrix (M4.5 Phase C migration shipped 2026-06-03, see [ADR-0004](docs/adr/0004-canonical-routing-alignment.md)). The Phase B Opus cap retired with that PR. Both the manual `/audit-*` pipeline and IFleet's classifier route per the same matrix today. The supersedure protocol (canonical §7) was the mechanism that let the two implementations stay coherent while the code change was tracked separately from the spec change.

## Identity

- **Type:** Internal infrastructure (open-source for the show, not a product)
- **Repo:** `weautomatehq1/IFleet` — public, branch-protected
- **Hosting:** Local dev + PM2 services (no external hosting)
- **Out of scope:** Stripe, multi-tenant, user signup, marketing site

## Architecture rule (load-bearing)

**SprintManager emits events. It NEVER calls GitHub directly.** All GitHub interactions flow through the queue bridge layer. Violating this couples sprint logic to GitHub's rate limits and webhook quirks — refuse PRs that bypass the bridge.

**Within-task fan-out is rejected (ADR-0001). Cross-task parallelism is in scope.** The manual `/splittasks` pattern (multiple independent terminals running concurrent single-trace tasks) is structurally equivalent to IFleet dispatching multiple GitHub Issues in parallel. Do not conflate this with "multi-agent debate within a single task" — that's what ADR-0001 rejected.

## Mandatory rules

1. Single-seat Max-plan policy — never spawn parallel Claude sessions that share quota (see `docs/running.md`)
2. Cross-provider rule: warn (not block) in single-provider pools (see PR #67/#68)
3. Editor must be Sonnet floor — never Haiku for editing code (see PR #73) (matches canonical-pattern routing in `~/.claude/skills/CANONICAL-PATTERN.md` Section 3)
4. Reviewer cost-split via Haiku gate (see PR #74)
5. Exit codes 2+3 route to cancel/blocked paths (see PR #64)
6. Worktrees clean up after themselves — `git worktree list` after every sprint
7. Build green mandatory — broken main blocks all sprints
8. Token efficiency always active

## Skills auto-load

- `superagent` (when designing sprint orchestration)
- `subagent-protocol` (when delegating to workers)
- `code-workflow` (mandatory phases A–F)
- `code-reviewer` agent (every block close)

## Project-specific

- Discord briefs go to **#ifleet** (channel `1504120127791042631`), never #general
- Budget tracking via `BUDGET_USD` env in PM2 ecosystem
- Control plane: custom discord.js + HMAC + SQLite + PM2 (`feat/discord-first-vps`, merged 2026-05-18). Claude Channels evaluated and rejected — not always-on, no HMAC, no crash recovery.
- Agent SDK (spawn-runner.ts): parked as future upgrade — open backlog issue when ready, don't implement now
