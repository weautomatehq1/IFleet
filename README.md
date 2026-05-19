# IFleet

<!-- Hello World -->

Autonomous agent fleet — Claude Code + Codex workers shipping PRs 24/7.

## What this is

A control plane + worker pool that picks tasks off a queue, dispatches them
to the right AI model (Claude Opus / Sonnet / Codex), runs each in an
isolated git worktree, opens a draft PR with CI passing, and reports back
to the operator. Designed for solo developers and small teams who want to
ship 5–15 PRs per night without sitting in front of a terminal.

## Status

V0 — scaffolding only. Architecture spec lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Stack

- **Runtime:** Node 20+, TypeScript via `tsx` (no build step)
- **Workers:** Claude Code Max (`claude -p --permission-mode auto`) + Codex CLI (`codex exec --json`)
- **Auth juggling:** CCS for Claude, codex-lb for Codex
- **Queue:** GitHub Issues with labels
- **Isolation:** one git worktree per task
- **Triggers:** Discord (herdctl) + GitHub Issues + cron
- **CI gate:** typecheck + lint + test before any PR opens

## Quick start

Not ready yet. Repo is currently scaffolding.

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
