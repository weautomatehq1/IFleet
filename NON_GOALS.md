# NON_GOALS — IFleet out-of-scope

> Loaded by global CLAUDE.md continuous execution rule. Proposer (M5) reads this nightly to avoid wasting cycles on rejected ideas.

## Not a product

IFleet is **internal infrastructure** for WeAutomateHQ — open source for the show, not sold. Therefore out of scope:

- Stripe / billing / paywalls
- Multi-tenant authentication or user signup
- Marketing site / landing pages
- Self-serve SaaS dashboards
- Free-tier vs. paid-tier feature gating
- Customer support / ticketing

## Not multi-agent

Per ADR-0001 (single-trace architecture):

- No fan-out to independent agents with private memory
- No multi-persona "debate" agents (rejected as v1 scope item; superseded by structured plan-reviewer in M2 with full trace access)
- No CrewAI / AutoGen-style autonomous agent meshes
- No agent-to-agent direct messaging that bypasses the SprintManager trace

## Not per-token cost tracking

Flat-rate plans only (Claude Max + Codex Pro). Therefore out of scope:

- Per-token cost dashboards
- Token budgets per task (we track sprint cost via `BUDGET_USD` env, not per-call tokens)
- Anthropic Cost Explorer integration

## Not always-on cloud

- No Claude Channels (rejected — not always-on, no HMAC, no crash recovery; see CLAUDE.md)
- No Vercel / Netlify hosting (Hostinger VPS only)
- No serverless functions for control plane

## Not embedding-only retrieval

Per ADR-0003 (knowledge graph stack):

- No pure-embedding code search (proven loser per RepoGraph + Codebase-Memory benchmarks)
- No vector DB-only architecture without symbolic layer

## Not goal-autonomous (without human gate)

Per Upgrade 6 (goal-driven mode):

- No autonomous PR opening from Proposer without HITL approval
- No "agent that decides what's worth working on" — IFleet proposes, humans veto
- Hard cap of 10 self-proposed PRs per repo per day, default 3

## Deferred until eval set ≥50

- Self-modifying IFleet (writes to its own codebase)
- Cross-repo coherence auto-PRs
- Economic routing bandit (needs 100+ samples per cell)

## Items consciously rejected from the previous architecture

- **Agent SDK spawn-runner** — parked; flat-rate plan policy makes the cost calculus unfavorable. Open backlog issue when reconsidering.
- **Three-tier autonomy frontmatter** — binary auto/review is sufficient given HITL approval gate.
- **Client-facing sprint reporter** — internal use only until Operating Standard (M0.W1) is signed off.
