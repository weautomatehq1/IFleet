# Upgrade 8 — Economic routing (Thompson sampling bandit)

**Month:** M6 | **Depends on:** Upgrades 1+4 stable (need outcome signal), 100+ tasks per `(repo_id, task_kind)` cell | **KPI:** Cost per task -25%

## What it does

IFleet's classifier currently routes statically (Haiku → architect:Opus, editor:Sonnet, etc.). After 100+ historical tasks per `(repo_id, task_kind)` cell, a Thompson sampling bandit overrides the static routing per cell.

Reward = `merged ? 1 : (verifier_passed ? 0.3 : 0)` minus cost penalty. Cap: one model swap per cell per week (so outcomes are attributable to the swap, not noise).

## Why it matters

- IFleet today doesn't know it ships frontend well and database migrations badly.
- Static routing wastes Opus on tasks Sonnet would handle; wastes Sonnet on tasks Haiku would handle.
- Bandit literature is well-developed: Martian's "Adaptive LLM Routing Under Budget Constraints," BaRP, RouteLLM all show 20-40% cost reductions.

## Build last

Bandits need data. Static classifier (existing `src/classifier/`) is correct at cold start. Only override after sufficient samples.

## Integration into IFleet

**New service:** `src/agents/economic-router/` — consulted by `pipeline/runner.ts` before each task. Falls back to existing classifier output when bandit has insufficient data.

**Files added in M6:**

```
src/agents/economic-router/
├── index.ts            # Routing decision — bandit OR static fallback
├── bandit.ts           # Thompson sampling implementation
├── update.ts           # Posterior update on task outcome
└── __tests__/
```

## Data model

```sql
CREATE TABLE routing_decisions (
  task_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,                -- classifier output (frontend | migration | refactor | etc)
  architect_model TEXT NOT NULL,          -- opus | sonnet | haiku | codex
  editor_model TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  routing_source TEXT NOT NULL,           -- static | bandit
  cost_usd REAL,                          -- filled in on task completion
  outcome TEXT,                           -- verifier_passed | merged | rejected | failed
  duration_sec INTEGER,
  rewarded_at TIMESTAMPTZ                 -- when posterior was updated
);
CREATE INDEX idx_routing_repo_kind ON routing_decisions(repo_id, task_kind);

CREATE TABLE bandit_arms (
  repo_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  architect_model TEXT NOT NULL,
  editor_model TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1.0,        -- Beta distribution parameter
  beta REAL NOT NULL DEFAULT 1.0,
  pulls INTEGER NOT NULL DEFAULT 0,
  last_swap_at TIMESTAMPTZ,
  PRIMARY KEY (repo_id, task_kind, architect_model, editor_model)
);
```

## Bandit logic

**Cold start** (`pulls < 100` per `(repo_id, task_kind)`):
- Use existing classifier routing (static)
- Insert `routing_decisions` with `routing_source: 'static'`
- Still update `bandit_arms` posterior on outcome (warm up the prior)

**Warm** (`pulls >= 100`):
- Sample one model combo via Thompson sampling: for each arm, draw θ ~ Beta(α, β); pick max θ
- Enforce: no swap if `last_swap_at` < 7 days ago for this cell → reuse last decision
- Insert `routing_decisions` with `routing_source: 'bandit'`

**Posterior update** (when task completes):
```
reward = (merged ? 1.0 : (verifier_passed ? 0.3 : 0)) - cost_penalty
cost_penalty = cost_usd / max_cost_for_kind   # normalize 0..1
alpha += reward
beta  += 1 - reward
pulls += 1
```

## Pipeline step

**At task-routing time:**
```typescript
const arms = await loadBanditArms(task.repo_id, task.task_kind);
const decision = arms.pulls >= 100
  ? thompsonSample(arms, lastSwapPolicy)
  : staticRouting(classifierOutput);
emit('routing.decided', { taskId, decision, source: arms.pulls >= 100 ? 'bandit' : 'static' });
```

**At outcome-time:**
```typescript
on('verifier.passed' | 'verifier.failed' | 'pr.merged' | 'pr.rejected', async (e) => {
  await updatePosterior(routingDecision, computeReward(e));
});
```

## Discord interface

| Command | Behavior |
|---|---|
| `/routing stats [--repo X]` | Per-cell: pulls, current best arm, cost trend, last swap |
| `/routing force <repo> <task_kind> <architect> <editor>` | Override bandit for next task (debugging only, gated by `allowedUserIds`) |

## Failure modes

| Failure | Handling |
|---|---|
| Insufficient samples (<100) | Static routing (current behavior) |
| Bandit picks an arm that costs more but doesn't reward | One swap/week rule limits damage; posterior will downweight |
| Model deprecated mid-experiment | Force arm with deprecated model to `pulls = 0`, alpha = 1, beta = 1 (cold start) |
| Reward signal delayed (PR not yet reviewed) | Update posterior on `verifier_passed` (partial reward 0.3); update again on merge (additional 0.7) |
| Cell with very low volume (5 tasks/month) | Never enters warm state; static routing forever; flag in `/routing stats` |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 | Schema + backfill from past 60 days of `routing_decisions` (cold-start posteriors). |
| W2 | Bandit logic + Thompson sampling. Falls back to static when `pulls < 100`. |
| W3 | Posterior update on outcomes. One-swap-per-week enforcement. |
| W4 | Discord commands + monitoring. |

## Verification (Definition of Done for M6 routing)

- At least 1 cell has `pulls >= 100` and is in warm state at end of M6.
- For warm cells: cost per task measurably lower than static baseline (queryable via `/routing stats`).
- 0 cases where bandit swapped >once in a week for any cell.
- Reward signal correctly attributed to routing decision (manually validated on 5 sample tasks).

## References

- [Adaptive LLM Routing Under Budget Constraints (Martian)](https://martianlantern.github.io/2025/09/llm-routing/)
- [Learning to Route LLMs from Bandit Feedback (BaRP)](https://arxiv.org/pdf/2510.07429)
- [Not Diamond awesome-ai-model-routing](https://github.com/Not-Diamond/awesome-ai-model-routing)
- [Thompson Sampling tutorial](https://en.wikipedia.org/wiki/Thompson_sampling)
