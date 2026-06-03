# IFleet — Architecture

> Status: implemented. This document describes the live system (M4).
> The Source layout section at the bottom was reverified against
> `tree -L 2 src/` on 2026-06-02 (T7 audit) — `src/` remains the source
> of truth when discrepancies appear.

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

**Policy intent — canonical correctness-first matrix** (per `~/.claude/skills/CANONICAL-PATTERN.md` §3). This is the spec IFleet is aligning to; the live classifier still enforces Phase B until M4.5 (Phase C migration) ships. For the live cost-first Phase B policy that runs today, see [`docs/MODEL-ROUTING.md`](MODEL-ROUTING.md) — that doc carries the supersedure header. For the runtime config the classifier reads, see [`config/routing.json`](../config/routing.json).

| Pattern | Model | Rationale |
|---|---|---|
| `CRITICAL` × any category | Opus | Mistake cost > model cost |
| Any × `security` / `auth` / `payments` / `migration` | Opus | High blast radius — pay for Opus up front |
| `IMPORTANT` × `correctness` (logic, multi-file) | Sonnet | Workhorse default |
| `IMPORTANT` × `maintainability` touching call sites | Sonnet | Refactor reasoning |
| `IMPORTANT` × procedural config (env, log routing) | Sonnet | Config has logic |
| `COSMETIC` × style / lint / whitespace / import-sort | Haiku | Mechanical, glance-reviewable |
| Truly atomic single-line (chmod, missing import, typo) | Haiku | Low blast radius |
| Ambiguous shape | Sonnet | Round up |

**Override precedence (highest wins):**
1. Any `category` ∈ {`security`, `auth`, `payments`, `migration`} → Opus regardless of severity.
2. `CRITICAL` severity → Opus regardless of category.
3. Otherwise the matrix row that matches.

**Reviewer floor (orthogonal to the matrix, retained from M2):** Plan-Reviewer is bounded by "reviewer not weaker than architect" — Opus architect → Sonnet plan-reviewer floor; Sonnet architect → Haiku floor; Haiku architect → Haiku. Configured in [`config/routing.json#pipeline.planReviewer`](../config/routing.json).

**Safety-net assumption:** the matrix above assumes the strict-mode review gate is enforced (every audit-fix PR runs `/codex-review` + Claude `verifier` in parallel; both must PASS to merge). If that gate is disabled, downshift the entire matrix one tier — the gate is what makes the cheaper tiers safe.

## Pipeline per task (4 roles — M2)

1. **Architect** — model chosen per the [Routing rules](#routing-rules) matrix above (canonical correctness-first; live behaviour follows Phase B until M4.5 ships). Reads brief, writes plan, posts to issue, waits for ✅.
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

## Source layout

> Verified against `tree -L 2 src/` as of 2026-06-02 (T7 audit). `src/` is the source of truth when drift appears.

```
src/
├── agents/             specialist agent modules
│   ├── architect/      plan generation
│   ├── canary/         disagreement-rate canary alerts
│   ├── indexer/        KG indexer (ADR-0003)
│   ├── rituals/        scheduled standup / retro posts (PM2 cron)
│   └── verifier/       Docker sandbox verifier (ADR-0002)
├── audit/              audit scan + fingerprint tooling
├── classifier/         brief → model routing
├── config/             runtime config loading
├── contracts/          shared type contracts
├── discord/            Discord client + event handlers
│   └── handlers/
├── mcp/                MCP stdio server tools
│   └── tools/
├── observability/      event log, Discord status cards
├── orchestrator/       routing brain, state machine, cancellation
├── pipeline/
│   ├── architect.ts
│   ├── plan-reviewer.ts  M2 — vets plan before editor; veto with structured reasons
│   ├── editor.ts
│   ├── diff-reviewer.ts  cross-provider review of editor's diff (was reviewer.ts pre-M2)
│   ├── reviewer.ts       deprecated shim re-exporting diff-reviewer; remove next release
│   └── doctor.ts         on CI failure
├── queue/              GitHub Issues queue adapter
│   └── sources/
├── repos/              per-repo config and helpers
├── utils/              shared utilities
├── verify/
│   ├── ci.ts           typecheck + lint + test runner
│   └── playwright.ts   UI tasks only
└── workers/
    ├── claude.ts       spawns claude -p, parses stream-json
    ├── codex.ts        spawns codex exec --json
    └── adapters/       future worker backends (vLLM, Ollama, MLX, API)
```

> Note: `src/secrets/` documented in the pre-build target is absent — env injection is handled via PM2 `baseEnv` in `ecosystem.config.cjs`.
