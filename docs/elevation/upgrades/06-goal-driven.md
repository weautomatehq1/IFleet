# Upgrade 6 — Goal-driven mode (Proposer + budget gate)

**Month:** M5 | **Depends on:** Upgrades 1-4 stable | **KPI:** ≥1 approved+merged proposal/week, 0 noise complaints

## What it does

Voyager-pattern curriculum over repos. A `ProposerAgent` reads spec files + learnings + doctor fingerprints, generates 5-20 candidate goals nightly, scores them cheaply, top N pass through a human gate in Discord before becoming `/ship` tasks.

This is the "IFleet wakes up with ideas" capability. **Without the budget gate and HITL approval, it produces 40 broken PRs.** With them, it produces 1-3 quality proposals per repo per day.

## Why it matters

- You are the bottleneck. IFleet should propose, not just react.
- Spotify Honk Part 3 (Dec 2025): "strong feedback loops" differentiate background coding agents that work from ones that spam.
- Voyager's automatic curriculum in Minecraft achieved 3.3× more unique items, 15.3× faster progression — the architecture ports directly.

## Build last (M5, not M1)

**Critical:** do not build until Upgrades 1-4 are stable. Goal-driven mode amplifies whatever underlies it. If verifier is unreliable, the Proposer produces noise faster than you can triage.

## Integration into IFleet

**New service:** `src/agents/proposer/` — nightly cron, per repo.

**Reuses:**
- `src/orchestrator/approval-gate.ts` (existing HITL gate — extended for `kind: 'proposal'`)
- `src/pipeline/doctor-scan.ts` + `fingerprints.ts` + `rollup.ts` (substrate, already shipped)
- `src/pipeline/learnings.ts` (derived from trace per ADR-0001)

**Files added in M5:**

```
src/agents/proposer/
├── index.ts              # ProposerAgent — nightly run orchestration
├── candidate-gen.ts      # Haiku-driven candidate generation from spec + learnings + doctor
├── scorer.ts             # Value/difficulty/sprint-alignment scoring
├── budget.ts             # Per-repo daily budget enforcement
├── dedupe.ts             # Semantic similarity against last 30d proposals
└── __tests__/
```

## Data model

```sql
CREATE TABLE goal_proposals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,                  -- sprint_gap | learnings | drift | error_log | coherence
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  estimated_value REAL,                  -- 0..1
  estimated_difficulty REAL,             -- 0..1
  embedding vector(1536),                -- for dedup
  decision TEXT,                         -- approved | rejected | deferred | expired
  decided_by TEXT, decided_at TIMESTAMPTZ,
  resulting_task_id TEXT,                -- backlinks to standard task pipeline
  resulting_pr_url TEXT,
  resulting_pr_outcome TEXT              -- merged | rejected | closed_unmerged
);
CREATE INDEX idx_proposals_repo_proposed ON goal_proposals(repo_id, proposed_at DESC);
CREATE INDEX idx_proposals_embedding ON goal_proposals USING hnsw (embedding vector_cosine_ops);
```

The `resulting_pr_outcome` column is what closes the loop — Voyager's iterative-prompting mechanism. Future proposer runs see "we tried this, it got merged / it got rejected."

## Pipeline step

**Nightly cron (per repo):**

```
1. Load context
   - SPRINT.md, ROADMAP.md, NON_GOALS.md
   - learnings.md (derived)
   - Last 7d doctor fingerprints
   - Last 30d PR decisions (Upgrade 5)
   - Last 30d goal_proposals + their outcomes

2. Generate candidates (Haiku, cheap)
   - "Given the above, propose 5-20 concrete tasks aligned with the sprint goal,
      excluding NON_GOALS items and dedup against past 30d proposals."
   - Output: structured JSON array of {title, rationale, estimated_value, estimated_difficulty}

3. Score & filter
   - Dedup: cosine similarity ≥0.85 against last 30d → drop
   - Drop bottom 80% by combined score
   - Force-explore one low-score for learning (bandit-style)

4. Enforce budget
   - Read proposer_budget for this repo (default 3, hard max 10)
   - Take top N

5. Post to Discord
   - One message per candidate in #ifleet-proposals
   - [Approve] [Reject] [Defer] buttons

6. On approval
   - Enqueue as standard /ship task
   - Backlink resulting_task_id in goal_proposals

7. On PR outcome (merged/rejected)
   - Update resulting_pr_outcome
   - Feed into next nightly run's "we tried this" context
```

## Discord interface

| Command | Behavior |
|---|---|
| `/propose <repo>` | Manually trigger a proposer run (overrides daily budget by +1) |
| `/proposer-budget <repo> <n>` | Set daily PR cap (default 3, hard max 10) |
| `/proposals [--repo X] [--decision Y]` | List recent proposals with filters |

**New channel:** `#ifleet-proposals` (or per-repo). Each candidate is one message:

```
💡 Proposal: Add invariant rule preventing direct Supabase calls in src/api/
   value: 0.7 | difficulty: 0.3 | source: learnings.md
   Rationale: Last 3 PRs that crossed this boundary were rejected. Codifying as
   Semgrep rule prevents repeated work.

   [Approve] [Reject] [Defer]
```

## Failure modes

| Failure | Handling |
|---|---|
| Hallucinated goal not in SPRINT.md | Low alignment score → dropped before posting |
| Same goal proposed every night | Semantic dedup against last 30d |
| Approved goal fails verifier 3× | Auto-reject + write to learnings.md with failure mode |
| Noise complaints from Sebastian | Tighten scoring threshold; reduce default budget; require ROADMAP.md cross-reference |
| Proposer LLM cost spike | Proposer `cost_usd` accumulates into the sprint's existing `BUDGET_USD` guard; if the sprint guard trips, the Proposer aborts with the rest of the sprint (no new per-task scarcity cap — reuse the per-sprint guardrail) |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 | `goal_proposals` schema + backfill from past sprints (mark all as `decision: 'approved', resulting_pr_outcome: merged'` to seed the loop). |
| W2 | Candidate generator + scorer + dedup. Manual `/propose <repo>` command works end-to-end. |
| W3 | Nightly cron + Discord posting + buttons. Budget enforcement. |
| W4 | Outcome-tracking loop (resulting_pr_outcome feedback). Tune scoring threshold from M5.W3 data. |

## Verification (Definition of Done for M5)

- 7 consecutive nightly runs produce ≥1 proposal each.
- ≥1 proposal approved and merged in week 1 of operation.
- 0 proposals violate NON_GOALS (verified by Sebastian over the week).
- Dedup catches at least 1 duplicate (verified by inspecting `goal_proposals` for cos_sim ≥0.85 cases).
- Proposer `cost_usd` over the 7-day DoD window stays within the sprint `BUDGET_USD` guardrail (no separate proposer-only cap; share-of-sprint-budget reported in week-end rollup against `verifier_runs.cost_usd`).

## References

- [Voyager: Open-Ended Embodied Agent (NeurIPS 2023)](https://voyager.minedojo.org/)
- [Voyager paper](https://arxiv.org/abs/2305.16291)
- [Spotify Engineering: Honk Part 3 — Background Coding Agents](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)
- [Sweep AI](https://www.onegen.ai/project/sweep-ai-automated-github-issue-resolution-and-pull-request-generation/)
