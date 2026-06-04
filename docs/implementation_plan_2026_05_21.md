---
name: ifleet-implementation-plan-2026-05-21
description: "7-phase, ~10-week IFleet build plan green-lit 2026-05-21. Locks observability-first ordering and demotes M5 generative-Proposer in favor of curatorial Task Surfacer. Source of truth for next 10 weeks of IFleet work."
metadata: 
  node_type: memory
  type: project
  originSessionId: b431f396-8668-4ed0-87cb-84c426821147
---

Locked plan for IFleet's next 10 weeks. Green-lit by Sebastian 2026-05-21 after multi-turn research + push-back cycle.

**Why:** IFleet's strategic identity is *internal productivity tool* (fleet types, Sebastian directs) — NOT public showcase, NOT future product. Metric: minutes-of-Sebastian-attention per shipped PR. Plan was rebuilt around that. Esme is out (busy), so review bandwidth ceiling = Sebastian's daily attention; auto-approval for low-risk paths becomes critical.

**How to apply:** When Sebastian arrives in a new session and asks "what's next on IFleet?", read this memory and the relevant phase. Do not deviate from phase order without his explicit approval. Decision checkpoints between phases are mandatory pauses.

## Phase order (locked)

1. **P1 Observability** (2 wk) — Langfuse on VPS, ccusage + monitor, 1h prompt cache, A/B eval-replay baseline. Cameras first so every later phase is measurable.
2. **P2 Audit integration** (3 wk) — Folds audit-elevation into the fleet. 5 ADRs, AuditSource adapter, AuditScanner role, closed-loop wiring, lane scheduler. 4 of 8 PRs touch protected paths.
3. **P3 Discord-first backlog + multi-repo** (2 wk) — Repo registry, handoff.md parser, `/ifleet inbox`, free-text ship command, max-in-flight cap. NO GitHub issues (Sebastian's call).
4. **P3b Task Surfacer** (3 days) — "Let's work on `<repo>`" reads SPRINT.md + ROADMAP.md + handoff.md + audits + git state → next task with brief. Curatorial, NOT generative. Skip-reasons logged as preference signal.
5. **P4 Verifier sharpening** (3 wk) — Property-based testing (Generator+Tester pattern), TDAD test-impact, post-merge probe + auto-rollback, AST-denoised diffs.
6. **P5 Skills + memory** (3 wk) — Anthropic memory tool for architect, Claude Agent Skills migration, skills for n8n / Supabase / Next.js / Stripe / Documenso, Serena MCP.
7. **P6 Attention budget** (1 wk) — Discord brief batching, quiet hours (7pm-7am), `/ifleet pause N`, risk-scored auto-approval for docs/formatting/dep-bumps.
8. **P7 Cross-repo coherence** (2 wk) — Standard-stack template + drift scanner across 17 repos.

## P1 status (2026-06-03)

ADR-0005 (`docs/adr/0005-langfuse-on-vps.md`) drafted in the M4-foundation-plus-obs split session T5; landed in PR `docs/p1-langfuse-vps-adr`. ADR-0005 not ADR-0004 because the 0004 slot was taken by `canonical-routing-alignment.md` on the same day — naming changed, decision unchanged. Skeleton compose at `deploy/langfuse/docker-compose.yml` plus `README.md` + `.env.example` capture port choices (web on `127.0.0.1:3010`, everything else internal-only — `arca` keeps 3000). Three load-bearing decisions still pending from Sebastian before P1.W1 implementation begins: (1) VPS RAM headroom — does the current Hostinger plan have ≥ 4 GB free for ClickHouse, (2) self-host vs Langfuse Cloud free tier, (3) 1h prompt cache enable. Ready to start P1 implementation as soon as those three resolve; ccusage + monitor and the A/B eval-replay baseline are downstream of the Langfuse decision.

## Demoted / removed from original roadmap

- **M5 generative Proposer** — replaced by P3b curatorial Task Surfacer.
- **M4 PR-learning W2-W4** — sparse signal in solo-reviewer world. Signal source pivots to skip-reasons from P3b, not PR rejections.
- **Daytona / E2B sandbox upgrade** — plain Docker fine for internal trusted code.
- **Critic-model + N-sample inference scaling** — marginal at this scale.
- **SWE-bench chasing** — contaminated benchmark, irrelevant for internal tool.
- **Two-reviewer model** (Esme) — Esme out; auto-approval replaces it.

## Decision checkpoints (mandatory pauses)

- After P1 — review baseline numbers; if KG (M3) isn't moving the needle, P5 priorities shift.
- After P2 — audit findings volume tells us if audit-as-signal-source is real.
- After P3b — first week of "let's work on X" usage tells us if priority hierarchy needs reorder.
- After P4 — property-test catch rate determines whether to expand the second-oracle approach.

## Task Surfacer priority hierarchy (locked from Q5)

1. In-flight (current branch, open PRs)
2. CRITICAL audit findings
3. Current sprint task list (`SPRINT.md`)
4. Next milestone in `ROADMAP.md`
5. Ghost-bugs in `handoff.md`

## Source materials

- Research synthesis from two parallel general-purpose agents (SOTA coding agents + observability/memory stack), 2026-05-21
- Plan iterated through Sebastian's brutal-honesty request, strategic-identity answer, and Proposer-misread correction
- See full plan in the chat transcript that produced this memory

## Open dependencies on Sebastian

- VPS headroom confirmation before P1.1 ships (Langfuse needs ClickHouse).
- His hands-on review on all protected-path PRs (`src/orchestrator/sprint.ts`, `src/queue/**`, `src/server.ts`, `nginx/**`, `ecosystem.config.cjs`).
- Decision-checkpoint sign-offs between phases.

Related: [[user_seb]] [[ifleet_repo]] [[ifleet_architecture]] [[ifleet_elevation_plan]] [[elevation_audit_shipped_20260521]] [[feedback_no_budget_caps_claude_max]]
