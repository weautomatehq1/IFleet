# IFleet — Architecture

> Status: implemented. This document describes the live system (M4). The
> "Source layout (target)" section at the bottom predates the build and may
> drift from the current tree — `src/` is the source of truth.

## Goal

Ship 5–15 pull requests per night, autonomously, with zero variable cost.
Operator (Seb) reviews and merges in the morning.

> **Umbrella view:** see [`weautomatehq1/factory/ARCHITECTURE.md`](https://github.com/weautomatehq1/factory/blob/main/ARCHITECTURE.md) for the system-of-systems view across Factory + IFleet + voice-discovery + spec-template + per-client repos. This file covers **IFleet-internal detail only**. IFleet is one of four Factory-umbrella repos; its job inside the umbrella is the "build robot army" container described in Factory's Container View (C4 L2).

## Constraints

- Flat-rate plans only — Claude Max + Codex Pro. No per-token spillover.
- Realistic ceiling: 5 Claude Max accounts × ~3 concurrent = ~15 lanes.
- Solo operator today, growing to 2–3 humans over the next month.
- Branch protection enforced server-side — no agent can touch `main`.

## High-level shape

```
Control plane (Discord / web / GitHub issue) →
  GitHub Issues queue (labels drive routing) →
    Orchestrator (TypeScript, always-on) →
      Worker pool (Claude + Codex, isolated worktrees) →
        Pipeline per task (Architect → Plan-Reviewer → Editor → Diff-Reviewer) →
          CI gate → Draft PR → Operator merges
```

## Components

| Component | Build vs Adopt | Source |
|---|---|---|
| Discord trigger | Build | custom discord.js + HMAC + SQLite + PM2 (always-on, per-task threads, crash recovery) |
| Worktree/PR engine | Adopt | `ComposioHQ/agent-orchestrator` |
| Claude multi-account auth | Adopt | `CCS` |
| Codex multi-account auth | Adopt | `codex-lb` |
| Rate-limit wait/resume | Adopt | `OMC` (`omc wait`) |
| Routing brain | Build | `src/orchestrator/` |
| GitHub Issues queue adapter | Build | `src/queue/github.ts` |
| Cross-provider diff review | Build | `src/pipeline/diff-reviewer.ts` (renamed from `reviewer.ts` in M2 — `reviewer.ts` is a deprecated re-export shim) |
| Plan review (M2) | Build | `src/pipeline/plan-reviewer.ts` |
| Brief library + classifier | Build | `src/classifier/` + `docs/briefs/` |
| Event log / observability | Build | `src/observability/` |

## Routing rules

See [`config/routing.json`](../config/routing.json) for the live config and [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md) for the full Phase B model routing policy with worked examples.

| Task type | Architect | Plan-Reviewer | Editor | Diff-Reviewer |
|---|---|---|---|---|
| Architecture / debugging / auth | Opus | Sonnet | Opus | Codex |
| UI / frontend | Opus | Sonnet | Sonnet | Codex |
| Bulk refactor / test gen | Opus | Sonnet | Codex | Sonnet |
| SQL / RLS / migrations | Opus | Sonnet | Opus | Codex |

Plan-Reviewer tier is bounded by the "reviewer not weaker than architect" rule:
Opus architect → Sonnet plan-reviewer floor; Sonnet architect → Haiku floor;
Haiku architect → Haiku. Configured in
[`config/routing.json#pipeline.planReviewer`](../config/routing.json).

## Pipeline per task (4 roles — M2)

1. **Architect** — Claude Opus (Phase A: capped to Sonnet via `mapModel` in `scripts/run-smoke.ts`; see Phase A Constraints). Reads brief, writes plan, posts to issue, waits for ✅.
2. **Plan-Reviewer** *(new in M2 — [02-plan-reviewer.md](elevation/upgrades/02-plan-reviewer.md))* — Haiku/Sonnet (per routing floor). Reads architect's plan + applicable invariants + recent learnings. Outputs strict JSON: `approve` or `veto` with structured `reasons[]`. After 2 vetoes the runner escalates to a human via `@Sebastian` ping.
3. **Editor** (Codex or Sonnet) — writes code in an isolated worktree.
4. **Diff-Reviewer** (the opposite provider) — reads diff in a fresh session, posts review. Implementation lives in `src/pipeline/diff-reviewer.ts` (was `reviewer.ts` before M2).
5. **CI gate** — typecheck + lint + test (+ Playwright for UI tasks).
6. **Draft PR** — only opens if all checks green.

## Failure modes (handled in v1)

- Rate limit on a worker → `omc wait` until window resets, or hand off to peer account.
- Editor produces broken diff → doctor.ts inspects CI log, proposes fix, max 2 retries.
- Reviewer blocks → PR stays draft, posts blocking concerns to operator.
- Orchestrator crashes mid-sprint → SQLite state survives, resume on restart.
- Operator hits `/cancel` → orchestrator drains current agents cleanly.

## Out of scope for v1

- Multi-persona debate agents (V2 once we have failure data).
- Three-tier autonomy frontmatter (binary auto/review for now).
- Per-token cost tracking (flat-rate plans only).
- Client-facing sprint reporter (internal use only for now).

## Source layout (target)

```
src/
├── orchestrator/       routing brain, state machine, cancellation
├── workers/
│   ├── claude.ts       spawns claude -p, parses stream-json
│   └── codex.ts        spawns codex exec --json
├── queue/
│   └── github.ts       reads/writes GitHub Issues as the queue
├── pipeline/
│   ├── architect.ts
│   ├── plan-reviewer.ts  M2 — vets plan before editor; veto with structured reasons
│   ├── editor.ts
│   ├── diff-reviewer.ts  cross-provider review of editor's diff (was reviewer.ts pre-M2)
│   ├── reviewer.ts       deprecated shim re-exporting diff-reviewer; remove next release
│   └── doctor.ts         on CI failure
├── verify/
│   ├── ci.ts           typecheck + lint + test runner
│   └── playwright.ts   UI tasks only
├── classifier/         brief → model routing
├── observability/      event log, Discord status cards
└── secrets/            per-project env injection
```
