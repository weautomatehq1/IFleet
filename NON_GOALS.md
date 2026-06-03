# NON_GOALS — IFleet out-of-scope

> **Item categorization:** "Permanent rejections" are vetoed in perpetuity — adding any back requires evidence-based ADR. "Build-time decisions" are revisitable as priorities evolve; the canonical pattern at `~/.claude/skills/CANONICAL-PATTERN.md` is the current authority. "Deferred" items unblock when their named gate condition is met.

> Loaded by global CLAUDE.md continuous execution rule. Proposer (M5) reads this nightly to avoid wasting cycles on rejected ideas.

## Permanent rejections (revisit only with strong evidence + new ADR)

IFleet is **internal infrastructure** for WeAutomateHQ — open source for the show, not sold:

- Stripe / billing / paywalls
- Multi-tenant authentication or user signup
- Marketing site / landing pages
- Self-serve SaaS dashboards
- Free-tier vs. paid-tier feature gating
- Customer support / ticketing

Per ADR-0001 (single-trace architecture) — vetoed in perpetuity; the canonical pattern explicitly inherits this ADR:

- Multi-persona "debate" agents within a single task (rejected as v1 scope item; superseded by structured plan-reviewer in M2 with full trace access)
- Fan-out to independent agents with private memory
- CrewAI / AutoGen-style autonomous agent meshes
- Agent-to-agent direct messaging that bypasses the SprintManager trace

Per ADR-0003 (knowledge graph stack) — vetoed in perpetuity; canonical pattern inherits:

- Pure-embedding code search (proven loser per RepoGraph + Codebase-Memory benchmarks)
- Vector DB-only architecture without symbolic layer

Infrastructure permanent rejections:

- Serverless functions for control plane
- Claude Channels (rejected — not always-on, no HMAC, no crash recovery; see CLAUDE.md)

## Build-time decisions (revisitable; canonical-pattern is current authority)

These items were decided at a point in time and may be revisited as the project matures. The canonical pattern at `~/.claude/skills/CANONICAL-PATTERN.md` is the current authority; where this list conflicts with that spec, the spec wins.

- **Phase B Opus cap** — superseded by canonical-pattern Section 3 (correctness-first routing matrix). Code alignment (Phase C migration in `src/classifier/index.ts`) is a tracked work item; both policies are live until then. See `docs/MODEL-ROUTING.md` supersedure header.
- **Three-tier autonomy frontmatter** — binary auto/review is sufficient given HITL approval gate. Revisit when goal-autonomous mode (see Deferred section) unblocks.
- **Per-token cost tracking** — flat-rate plans only (Claude Max + Codex Pro); per-call token budgets not tracked. Sprint cost tracked via `BUDGET_USD` env. Revisit if plan changes.
- **Agent SDK spawn-runner** (spawn-runner.ts) — parked; flat-rate plan policy makes cost calculus unfavorable. Open backlog issue when reconsidering, don't implement now.
- **Client-facing sprint reporter** — internal use only until Operating Standard (M0.W1) is signed off.
- **Vercel / Netlify hosting** — Hostinger VPS only; revisit if hosting strategy changes.
- **`model:*` label routing wiring** — label shape exists in queue; direct label→model routing in classifier deferred until Phase C migration aligns with canonical-pattern Section 3.

## Deferred behind specific gates

These items are explicitly in scope for a future phase but blocked on named gate conditions. Do not implement until the gate condition is met.

- **Self-modifying IFleet** — gate: eval set ≥50 + protected paths defined + Operating Standard (M0.W1) approved + shadow-eval harness operational + rollback.sh implemented.
- **Cross-repo coherence auto-PRs** — gate: self-modifying IFleet unblocked (above).
- **Economic routing bandit** — gate: 100+ closure samples per routing cell. Needs fingerprint data from M4 stabilization.
- **Goal-autonomous mode without HITL approval** (Upgrade 6) — gate: Proposer M5 signed off. Until then: no autonomous PR opening from Proposer without HITL approval; hard cap of 10 self-proposed PRs per repo per day (default 3).
