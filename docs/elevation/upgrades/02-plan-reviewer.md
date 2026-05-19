# Upgrade 2 — Plan-Reviewer agent (NOT the existing diff-reviewer)

**Month:** M2 | **Depends on:** Upgrade 1 (M1 complete) | **KPI:** 20% of plans get reviewer feedback; bugs caught pre-verifier

## Critical clarification

IFleet **already has** `src/pipeline/reviewer.ts` — that is a **diff-reviewer** (cross-provider, reads the diff after editor). This upgrade adds a **plan-reviewer** (reads the architect's plan **before** editor runs, can veto with structured `reasons[]`).

Both reviewers stay. They catch different bugs. The MARS paper validates this pattern.

## What it does

Inserts a new role between Architect and Editor:

```
Existing:   classifier → architect → editor → ...
New M2:     classifier → architect → plan-reviewer → editor → ...
                              ↑           ↓
                              └─── veto with structured reasons[]
```

Plan-reviewer reads the architect's plan + the full trace. Outputs either:
- `approve` — proceeds to editor
- `veto` — emits `{ reasons[]: { kind, message, suggested_revision }[] }` and pauses; architect re-runs with the veto reasons appended to its input

Max 2 veto cycles before escalating to human (`@Sebastian` Discord ping with structured disagreement).

## Why it matters

- Diff-reviewer catches code-level bugs.
- Plan-reviewer catches plan-level bugs ("this approach won't work because the schema migration will lock the table for 30 min").
- Cheaper than fixing post-editor (no code written yet).
- Devin Review (post-editor diff review) catches 2 bugs/PR, 58% severe — extrapolating, plan-level review catches the 80% of those that are detectable pre-code.

## Integration into IFleet

**Files added/changed:**

```
src/pipeline/
├── plan-reviewer.ts          # NEW — the new role
├── diff-reviewer.ts          # RENAMED from reviewer.ts (with re-export shim for 1 release)
└── runner.ts                 # CHANGED — inserts plan-reviewer between architect and editor
```

**ARCHITECTURE.md update (M2.W1):** pipeline becomes 4 roles (architect → plan-reviewer → editor → diff-reviewer), not 3.

## Prompt strategy

Plan-reviewer is fed:
1. The full trace so far (architect's plan, all prior events)
2. The brief
3. The applicable invariants from `.ifleet/invariants/<repo>/`
4. Top-K similar past plans from the knowledge graph (M3+; in M2 this is a TODO)
5. A reviewer prompt: "You are a senior engineer reviewing this plan. Veto if any of: (a) plan violates an invariant, (b) plan misses a known failure mode in this repo's learnings, (c) plan would require >5 retries to converge, (d) plan crosses into NON_GOALS. Otherwise approve."

Output schema (strict JSON):
```typescript
type PlanReview =
  | { decision: 'approve'; rationale: string }
  | { decision: 'veto'; reasons: Array<{ kind: 'invariant' | 'failure-mode' | 'scope' | 'feasibility'; message: string; suggested_revision: string }> };
```

## Model choice

- Plan-reviewer: **Haiku** initially (cheap, high volume). Upgrade to Sonnet for high-risk repos via routing config.
- The diff-reviewer stays cross-provider (Codex if Claude wrote, Claude if Codex wrote) per current architecture.

Critical rule from CLAUDE.md: "Reviewer not weaker than architect" — currently enforced for diff-reviewer. **Extended to plan-reviewer in this upgrade.** If architect = Opus, plan-reviewer ≥ Sonnet. If architect = Sonnet, plan-reviewer ≥ Haiku.

## Discord interface

No new commands. `/status <taskId>` shows plan-review state. On veto:

```
🛑 Plan-Reviewer vetoed plan (attempt 1/2)
  • invariant: Plan references `supabase.from()` in src/api/ — protected path
    Suggested: move DB call to src/data/users.ts
  • failure-mode: Repo's last 5 sprints failed when modifying both schema.prisma and src/data/ in one PR
    Suggested: split into two tasks
```

## Failure modes

| Failure | Handling |
|---|---|
| 2 vetoes in a row | Escalate to human via `@Sebastian` ping with structured disagreement |
| Plan-reviewer model unavailable (rate limit) | Skip review, log `plan_review: skipped`, alert in `#ifleet-ops` |
| Plan-reviewer hallucinates an invariant violation | Architect rebuts in next iteration; if reviewer vetoes 2× on the same hallucinated reason, escalate |
| Cost spike | Cap plan-review cost at 10% of architect cost; abort if exceeded |

## Data model

No new tables. Plan-reviewer events appear in the existing trace as:
```json
{ "role": "plan-reviewer", "kind": "completed", "payload": { "decision": "veto", "reasons": [...] } }
```

## Verification (Definition of Done for M2)

- 10 eval-set tasks replayed. Plan-reviewer vetoes ≥1; veto reasons are actionable (architect's revised plan addresses them).
- "Reviewer not weaker than architect" rule enforced in routing config.
- ARCHITECTURE.md updated to 4-role pipeline.
- Rename of `reviewer.ts` → `diff-reviewer.ts` with re-export shim landed in main, deprecation notice for next release.

## References

- [MARS: Multi-Agent Review System](https://arxiv.org/pdf/2509.20502)
- [LLM Critics Help Catch LLM Bugs (Anthropic)](https://arxiv.org/pdf/2407.00215)
- [Devin Annual Performance Review 2025](https://cognition.ai/blog/devin-annual-performance-review-2025)
