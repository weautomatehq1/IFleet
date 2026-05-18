# CLAUDE.md — IFleet

> Autonomous agent fleet. Claude Code + Codex workers shipping PRs 24/7. Public repo, branch-protected, single-seat Max-plan.

This repo inherits global rules from `~/.claude/CLAUDE.md`. Single-seat operational policy lives in `docs/running.md`.

**Umbrella context:** `weautomatehq1/factory` is the master coordination repo for "The Factory" — voice-AI interview → 17-file spec → IFleet builds → self-heals. Read `~/dev/coordination/factory/ARCHITECTURE.md` for the system-of-systems view across Factory + IFleet + voice-discovery + spec-template + per-client repos. This repo's docs cover **IFleet-internal detail only**. Cross-repo milestones live in `factory/ROADMAP.md` with bracketed `[M-NNN]` IDs; gap issues opened in this repo should be labeled `epic:M-NNN` to link back.

## Identity

- **Type:** Internal infrastructure (open-source for the show, not a product)
- **Repo:** `weautomatehq1/IFleet` — public, branch-protected
- **Hosting:** Local dev + PM2 services (no external hosting)
- **Out of scope:** Stripe, multi-tenant, user signup, marketing site

## Architecture rule (load-bearing)

**SprintManager emits events. It NEVER calls GitHub directly.** All GitHub interactions flow through the queue bridge layer. Violating this couples sprint logic to GitHub's rate limits and webhook quirks — refuse PRs that bypass the bridge.

## Mandatory rules

1. Single-seat Max-plan policy — never spawn parallel Claude sessions that share quota (see `docs/running.md`)
2. Cross-provider rule: warn (not block) in single-provider pools (see PR #67/#68)
3. Editor must be Sonnet floor — never Haiku for editing code (see PR #73)
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
- Architect complexity patch pending — see `~/architect-complexity-label.patch`, apply after PR #40 merges
