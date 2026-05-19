# Upgrade 5 — PR rejection learning

**Month:** M4 (ship with Upgrade 4) | **Depends on:** Upgrade 3 (KG/pgvector exists) | **KPI:** Reviewer preference cards populated for top 3 reviewers

## What it does

Every PR human review decision (merge / reject / request-changes + comment text) is stored structured, embedded, and retrieved at architect-time for similar future tasks.

**This is genuinely novel as a productized feature.** Closest existing work: CoRAL uses RL with semantic similarity for review-comment generation, but no production system retrieves human PR decisions as architect context.

## Why it matters

- Greptile, CodeRabbit, Devin Review catch issues but don't *learn from human merges over time*.
- Each reviewer has implicit preferences ("uses tabs not spaces", "wants tests in same PR", "rejects schema changes without ADR"). Today the architect re-discovers these every sprint.
- After 30 days of data, the architect can answer: "Has Sebastian historically merged or rejected this kind of change?"

## Integration into IFleet

**Files added in M4:**

```
src/agents/pr-watcher/
├── index.ts              # GitHub PR webhook handler — fires on review submitted, PR closed
├── store.ts              # Upsert into pr_decisions
├── embed.ts              # Embed diff_summary + concatenated review comments
└── digest.ts             # Weekly reviewer-preference-card generator

src/agents/architect/tools/
└── recall_pr_decisions.ts  # Architect tool — retrieve top-K similar past decisions
```

## Data model

```sql
CREATE TABLE pr_decisions (
  pr_url TEXT PRIMARY KEY,
  task_id TEXT,                              -- backlink to IFleet task that opened the PR (NULL if non-IFleet PR)
  repo_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  author_login TEXT NOT NULL,                -- who opened (IFleet bot OR human)
  reviewer_login TEXT,
  decision TEXT NOT NULL,                    -- merged | rejected | requested_changes | closed_unmerged
  decided_at TIMESTAMPTZ NOT NULL,
  review_comments JSONB,                     -- array of {path, line, body, suggestion}
  diff_summary TEXT,                         -- LLM-generated summary (Haiku, cheap)
  files_changed TEXT[],
  loc_added INTEGER, loc_removed INTEGER,
  embedding vector(1536),                    -- of diff_summary + concatenated comments
  CONSTRAINT decision_valid CHECK (decision IN ('merged', 'rejected', 'requested_changes', 'closed_unmerged'))
);
CREATE INDEX idx_pr_decisions_embedding ON pr_decisions USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_pr_decisions_repo_reviewer ON pr_decisions(repo_id, reviewer_login);
CREATE INDEX idx_pr_decisions_decided_at ON pr_decisions(decided_at DESC);
```

## Pipeline step

**At architect-time (M4+):**
```typescript
const similar = await recall_pr_decisions({
  query: brief.title + "\n" + plan.summary,
  repo_id: task.repo_id,
  reviewer_login: task.expected_reviewer, // if known
  limit: 5
});
// Inject as: "Previous review patterns for similar changes in this repo:
//   PR #N (merged): <diff_summary>. Reviewer comment: <body>
//   PR #M (rejected): <diff_summary>. Reviewer comment: <body>
//   ...
// "
```

**Weekly digest (cron, Sunday night):**
For each reviewer with ≥10 PR decisions in this repo, generate a "preference card" summarized into `learnings.md`:

```markdown
## Reviewer preference: @sebastianpuig (repo: weautomatehq1/IFleet, 47 decisions)

- Merges quickly: small refactors, test additions, doc fixes
- Frequently requests: ADR before schema change, tests for new endpoints
- Rejects: changes that touch `src/orchestrator/sprint.ts` without ADR
- Common comments: "split this PR", "where's the test?", "this needs an ADR"
```

## Discord interface

| Command | Behavior |
|---|---|
| `/preferences <reviewer> [--repo X]` | Show reviewer's preference card |
| `/recall "<query>" [--repo X]` | Manually query past decisions (debugging) |

PR-opened message gets an annotation if relevant past decisions exist:

```
✅ PR #234 opened
⚠️ similar past PRs: PR #198 (merged, +tests requested), PR #201 (rejected, no ADR)
```

## Failure modes

| Failure | Handling |
|---|---|
| GitHub webhook drops | Daily reconciliation cron — `gh pr list --state closed --search "updated:>24h"` |
| Reviewer login mismatch (bot vs human) | Skip rows where author is also a bot |
| Sensitive review comments (secrets, names) | Sanitization at write time; quarantine queue |
| Architect over-relies on past decisions for novel tasks | Cap injected context at 5 PR decisions, prioritize recency over similarity for cold-start tasks |
| Reviewer changes preferences over time | Recency-weighted similarity: e^(-age_days/90) × cosine_sim |

## Implementation order

Shared M4 sprint with Upgrade 4.

| Week | Deliverable |
|---|---|
| W1 | GitHub PR webhook handler. `pr_decisions` table + backfill from existing PRs in eval-set repos. |
| W2 | Diff-summary LLM (Haiku) + embedding pipeline. |
| W3 | Architect `recall_pr_decisions` tool. Integration in architect prompt. |
| W4 | Weekly digest cron + preference-card generator. Discord commands. |

## Backfill strategy (W1)

```bash
# Pull last 90 days of merged + closed PRs per repo
for repo in $(jq -r '.repos[]' .ifleet/config/repos.json); do
  gh pr list --repo "$repo" --state all --search "updated:>$(date -v-90d +%Y-%m-%d)" \
    --json url,number,author,reviews,mergedAt,closedAt,files,additions,deletions \
    > .ifleet/eval/raw/pr_decisions_$(echo $repo | tr '/' '_').json
done
node scripts/eval/backfill-pr-decisions.ts
```

Expect ~200-500 rows from backfill across 4 active repos.

## Verification (Definition of Done for M5 PR-learning)

- ≥200 rows in `pr_decisions` after backfill.
- Architect prompts include "Previous review patterns" section for ≥80% of new tasks.
- At least 1 reviewer preference card generated and reviewed.
- Discord `/preferences @sebastianpuig` returns a readable card.

## References

- [CoRAL: Reward Models for Code Review Comment Generation](https://arxiv.org/html/2506.04464)
- [LLM Critics Help Catch LLM Bugs](https://arxiv.org/pdf/2407.00215)
- [pgvector HNSW](https://github.com/pgvector/pgvector#hnsw)
