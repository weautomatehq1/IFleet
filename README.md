# IFleet

Autonomous agent fleet — Claude Code + Codex workers shipping PRs 24/7.

## What this is

A control plane + worker pool that picks tasks off a queue, dispatches them
to the right AI model (Claude Opus / Sonnet / Codex), runs each in an
isolated git worktree, opens a draft PR with CI passing, and reports back
to the operator. Designed for solo developers and small teams who want to
ship 5–15 PRs per night without sitting in front of a terminal.

## Status

Operational. The control plane, worker pipeline, GitHub queue, Discord control
surface, audit loop and observability stack are implemented (~25k LOC) and run
on a PM2-managed VPS. Architecture overview in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); day-to-day operation in
[`docs/RUNNING.md`](docs/RUNNING.md) and [`docs/LAUNCH.md`](docs/LAUNCH.md).
Cross-repo milestones live in `weautomatehq1/factory/ROADMAP.md`.

## Stack

- **Runtime:** Node 20+, TypeScript via `tsx` (no build step)
- **Workers:** Claude Code Max (`claude -p --permission-mode auto`) + Codex CLI (`codex exec --json`)
- **Auth juggling:** CCS for Claude, codex-lb for Codex
- **Queue:** GitHub Issues with labels
- **Isolation:** one git worktree per task
- **Triggers:** Discord (herdctl) + GitHub Issues + cron
- **CI gate:** typecheck + lint + test before any PR opens

## Quick start

```
pnpm install            # Node 20+, pnpm 10
pnpm typecheck          # tsc --noEmit
pnpm test               # node:test + vitest
```

Running the fleet (env, PM2 services, Discord control) is documented in
[`docs/RUNNING.md`](docs/RUNNING.md). Launch sequence in
[`docs/LAUNCH.md`](docs/LAUNCH.md).

## Layout

```
IFleet/
├── config/        worker registry, routing rules, channel map
├── docs/          architecture + brief library
├── src/           orchestrator, workers, queue adapters
└── .github/       CI + CODEOWNERS
```

## License

Private. Internal tooling.
