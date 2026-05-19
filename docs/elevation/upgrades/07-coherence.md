# Upgrade 7 — Cross-repo coherence watcher

**Month:** M6 | **Depends on:** Upgrade 3 (KG with `cross_repo_links`), Upgrade 6 (Proposer for approval flow) | **KPI:** Drift PRs >70% merge rate

## What it does

Daily cron. For each `cross_repo_link` of kind `same_entity` or `shared_schema`, diff the relevant defs across repos. On drift (e.g., repo A added a `User.last_seen_at` field that repo B's mirror type doesn't have), generate a `goal_proposal` for the lagging repo, flow through M5 approval gate.

This is the standing background process IFleet uses to keep cross-repo architecture coherent. Nobody has shipped this productized. Sourcegraph Batch Changes is the closest, but it's human-initiated and one-shot.

## Why it matters

- Today: cross-repo drift is silent until someone hits a runtime mismatch.
- With this: drift is detected within 24h, proposed as a fix candidate.
- Easy to build badly (50 noisy PRs). Hard to build well (only file PRs when the drift is actionable). Control = human gate inherited from M5.

## Integration into IFleet

**New service:** `src/agents/coherence-watcher/` — daily cron, reuses M3's `cross_repo_links` table.

**Files added in M6:**

```
src/agents/coherence-watcher/
├── index.ts            # CoherenceWatcher — daily orchestration
├── diff.ts             # Compute drift between cross_repo_linked entities
├── classify.ts         # Categorize drift: additive, breaking, ambiguous
└── propose.ts          # Generate goal_proposal for lagging repo
```

## Data model

No new tables. Adds two columns to `cross_repo_links`:

```sql
ALTER TABLE cross_repo_links
  ADD COLUMN last_checked_at TIMESTAMPTZ,
  ADD COLUMN drift_state TEXT;            -- aligned | drifted_additive | drifted_breaking | ambiguous
```

## Pipeline step

**Daily cron:**

```
1. For each cross_repo_link where human_confirmed = true:
     a. Fetch current state of src_node and dst_node (from code_nodes, latest sha)
     b. Compute diff:
        - same_entity: structural diff of type/class fields
        - shared_schema: SQL DDL diff
     c. Classify:
        - aligned: no diff → continue
        - drifted_additive: one side has more fields, no removals → propose addition to other side
        - drifted_breaking: removal or type change → escalate to human, no auto-proposal
        - ambiguous: can't tell which side is canonical → log, no proposal

2. For drifted_additive:
     a. Generate goal_proposal:
        - title: "Sync User.last_seen_at from repo A to repo B"
        - source: 'coherence'
        - rationale: explicit diff + link to both nodes
        - estimated_difficulty: low (additive)
     b. Insert into goal_proposals, flow through M5 approval gate

3. For drifted_breaking:
     a. Post to #ifleet-ops Discord channel
     b. @Sebastian ping with structured disagreement
     c. No auto-proposal — requires human triage
```

## Discord interface

| Command | Behavior |
|---|---|
| `/coherence stats` | Per-repo: drift count by state |
| `/coherence drifted [--breaking]` | List currently drifted links |
| `/coherence ignore <link_id>` | Mark a link as known-acceptable drift (e.g., one is intentionally a subset) |

Daily summary post (if any drift):

```
🔁 Coherence watcher — 3 drifts detected
  • additive: User.last_seen_at in IFleet not in voice-discovery → proposal #G-2147 posted
  • additive: TaskState.cancellable in IFleet not in factory → proposal #G-2148 posted
  • breaking: PR comment schema diff between IFleet and spec-template — needs review
```

## Failure modes

| Failure | Handling |
|---|---|
| False-positive drift (intentional schema divergence) | `/coherence ignore <link_id>` marks as acceptable |
| Stale graph (KG not indexed since last drift) | Wait for IndexerAgent to catch up; skip this run |
| Cross_repo_link confidence too low (<0.7) | Skip; require human re-confirmation |
| Proposal storm (10+ drifts on same day) | Batch into one summary message; cap proposals at proposer-budget for that repo |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 | Daily cron + diff computation for same_entity links. Reads from code_nodes. |
| W2 | Classify drift state. Update `cross_repo_links.drift_state`. |
| W3 | Propose for additive drift. Flow through M5 approval. Discord summary. |
| W4 | shared_schema diff (SQL DDL). Breaking-drift escalation. |

## Verification (Definition of Done for M6 coherence)

- ≥5 cross_repo_links exist with `human_confirmed = true` (depends on M3 link confirmation flow).
- 1 simulated drift → proposal generated → human-approved → PR opened → merged.
- 1 simulated breaking drift → no auto-proposal, human-pinged.
- 0 false positives over 7 days of operation.

## References

- [Sourcegraph Batch Changes](https://sourcegraph.com/docs/batch-changes)
- (No production reference for autonomous cross-repo coherence agent exists as of 2026 — this is novel territory.)
