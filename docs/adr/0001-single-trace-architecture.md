---
Status: Accepted (Amended 2026-05-20)
Date: 2026-05-19
Decider: Sebastian Puig
Supersedes: None
Superseded-by: None
Affects: Every subsequent agent added to IFleet
Extends: None
---

# ADR-0001 — Single shared trace, specialist roles, NOT multi-agent

**Status:** Accepted (2026-05-19, Amended 2026-05-20)
**Decider:** Sebastian Puig
**Affects:** Every subsequent agent added to IFleet

## Amendment — 2026-05-20 (PR #146 strict-diff)

Terminology normalization. Audit-fixes split `20260520-1145` T1 reviewer advisory (MEDIUM finding): the M0.U8 → Upgrade 10 rename in the Consequences section was applied in place, which the README immutability rule disallows. Path-A applied: original token struck through, new token preserved inline.

- Milestone label: `M0.U8` superseded by `Upgrade 10`. No decision change; label rename only.

The Consequences line below preserves the original token (struck through) immediately before the new label.

## Context

The June 2025 debate on multi-agent architectures split into two camps:

- **Cognition (Walden Yan, "Don't Build Multi-Agents"):** fan-out to sub-agents with isolated context produces drift. The canonical example: one sub-agent makes a Super Mario background, another makes an unrelated bird, because neither knows the other's implicit decisions. Solution: one long-running agent owns the full trace; sub-agents that *do* spawn inherit the entire context.
- **Anthropic / Microsoft Magentic-One / MetaGPT / MARS:** structured pushback between roles catches bugs that single-trace agents miss. Magentic-One achieves SOTA-competitive results on GAIA, WebArena, AssistantBench with an Orchestrator + Coder + WebSurfer + FileSurfer + ComputerTerminal team. MARS matches multi-agent debate accuracy with ~50% fewer tokens via Author → independent Reviewers → Meta-reviewer.

IFleet must commit to one architectural model before M1 because changing course in M3 costs ~3 months of untangling (private state, separate persistence, divergent prompts).

## Decision

**Single shared trace, specialist roles inside it.**

- `SprintManager` (existing) is the canonical trace owner. Architect, Plan-Reviewer, Editor, Diff-Reviewer, Verifier, Indexer, Proposer are **roles inside the trace** — not independent agents.
- Each role's input is `(trace_so_far, role_specific_prompt)`.
- **No role has private memory.** Anything a role learns or decides must be appended to the trace.
- Pushback is supported: Plan-Reviewer can emit a `veto` event with structured `reasons[]`; Architect must address before Editor runs (MARS pattern, single-trace constraint).
- `learnings.md` is **derived nightly from traces**, never edited directly. Edits would let writes happen outside the trace, which violates the invariant.

## Trace format (load-bearing — expensive to change later)

```typescript
type TraceEvent = {
  taskId: string;
  seq: number;                    // monotonic per task
  ts: number;                     // unix ms
  role: 'classifier' | 'architect' | 'plan-reviewer' | 'editor'
      | 'diff-reviewer' | 'verifier' | 'indexer' | 'proposer' | 'human';
  kind: 'started' | 'completed' | 'failed' | 'veto' | 'message' | 'tool-call' | 'tool-result';
  payload: Record<string, unknown>;  // role-specific
  cost_usd?: number;
  duration_ms?: number;
};
```

Persistence:
- SQLite (`src/orchestrator/store.ts`) — indexed `(taskId, seq)`. Live queries.
- S3-compatible blob (Hostinger provides) — full transcript export per task, addressable by `taskId`. Used for client-facing trace exports (see Operating Standard) and shadow eval.

## Alternatives considered

1. **Multi-agent with private memory (Magentic-One style).** Rejected — IFleet's scale (5-15 tasks/day) doesn't justify the context-drift risk Cognition documented. The MARS structured-pushback benefit is achievable in single-trace.
2. **Single agent with no pushback (pure Cognition).** Rejected — Devin Review (2 bugs/PR, 58% severe) shows reviewer-class roles catch real defects. Add the roles, keep them inside the trace.
3. **CrewAI-style role assignment with shared scratchpad.** Rejected — the "shared scratchpad" pattern is a weaker form of what we propose; lacks the append-only invariant that makes derivation possible.

## Consequences

**Positive:**
- Any role can be replayed for debugging by feeding the trace prefix
- `learnings.md` becomes a derived artifact — automatic, never drifts from reality
- Client-facing audit trail is one artifact per PR (Operating Standard requirement)
- Self-modification (~~M0.U8~~ Upgrade 10) shadow-eval can replay trace prefixes against candidate code

**Negative:**
- Every role must accept large context windows (the full trace). Mitigated by trace summarization at >100k tokens.
- Schema changes to `TraceEvent` are migrations, not config tweaks. Mitigated by `seq`-based versioning.
- Cannot easily add "side agents" that operate without writing to the trace — must adopt sidecar pattern (write to trace as `role: 'sidecar:name'`).

**Reversibility:** Switching to multi-agent later requires splitting the trace per agent and reconciling. Estimated 3-month cost. **Do not undertake without ADR-supersession.**

## Implementation notes

- Add `TraceEvent` type to `src/orchestrator/types.ts` (M0.W1)
- Migrate existing `store.ts` schema to include `trace_events` table (M0.W1)
- All new roles in M1-M6 must subclass a shared `TraceRole` interface (M1.W1)
- `learnings.md` derivation script runs nightly via existing cron (M1)

## References

- [Don't Build Multi-Agents — Cognition / Walden Yan](https://news.smol.ai/issues/25-06-13-cognition-vs-anthropic)
- [Magentic-One — Microsoft](https://arxiv.org/html/2411.04468v1)
- [MARS: Multi-Agent Review System](https://arxiv.org/pdf/2509.20502)
- [Devin 2025 Performance Review — Cognition](https://cognition.ai/blog/devin-annual-performance-review-2025)
