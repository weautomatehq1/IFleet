# The Private Evaluation Set

> Without this, you cannot tell if month-4 IFleet is better than month-1 IFleet. SWE-Bench Verified is contaminated (87.6% Opus 4.7 / 88.7% GPT-5.5 vs. ~53% on SWE-Bench Pro for the same models). You need your own holdout.

## What it is

A frozen JSONL file at `.ifleet/eval/eval-set.jsonl` containing 50-100 real historical tasks from your active repos. Each row:

```json
{
  "id": "ifleet-2026-001",
  "issue_url": "https://github.com/weautomatehq1/IFleet/issues/117",
  "pr_url": "https://github.com/weautomatehq1/IFleet/pull/117",
  "repo": "weautomatehq1/IFleet",
  "title": "feat: VS Code shared workspace settings",
  "body": "<issue body>",
  "classifier_label_actual": "feature",
  "diff_url": "https://patch-diff.githubusercontent.com/raw/weautomatehq1/IFleet/pull/117.diff",
  "diff_summary": "<3-sentence LLM summary of diff>",
  "files_changed": ["pnpm-workspace.yaml", ".vscode/settings.json", ".vscode/extensions.json"],
  "loc_added": 87,
  "loc_removed": 12,
  "merged_at": "2026-05-19T13:11:00Z",
  "reviewer_login": "sebastianpuig",
  "merge_decision": "merged_no_changes",
  "frozen_at": "2026-05-19T00:00:00Z"
}
```

## Why it matters

Every upgrade in the 6-month plan claims a KPI. Without an eval set, you cannot measure those KPIs honestly. You will fly on vibes, optimize for impressions of progress, and have no way to detect regression.

The eval set also doubles as the **shadow eval gate** for self-modifying IFleet (Upgrade 10): candidate code runs against eval-set tasks and must match or beat baseline on all metrics before approval.

## Bootstrap procedure (M0.W1 — one day)

```bash
# 1. Dump closed issues across active repos
for repo in weautomatehq1/IFleet weautomatehq1/factory weautomatehq1/voice-discovery weautomatehq1/spec-template; do
  gh issue list \
    --repo "$repo" \
    --state closed \
    --limit 200 \
    --json number,title,body,closedAt,labels,url \
    > ".ifleet/eval/raw/$(echo $repo | tr '/' '_').json"
done

# 2. Join with merged PRs (linked via "Fixes #N" or "Closes #N")
node scripts/eval/link-issues-to-prs.ts

# 3. Filter: only rows with a linked merged PR + clear before/after state
node scripts/eval/filter-evaluable.ts

# 4. Generate LLM diff summaries (cheap — Haiku)
node scripts/eval/summarize-diffs.ts

# 5. Freeze
mv .ifleet/eval/candidates.jsonl .ifleet/eval/eval-set.jsonl
git add .ifleet/eval/eval-set.jsonl
git commit -m "chore(eval): freeze v1 eval set (N=$(wc -l < .ifleet/eval/eval-set.jsonl))"
```

Target: ≥50 rows for M0.W1 ship, ≥100 by M4 (when self-improving IFleet unlocks).

## Metrics to track per upgrade

Each upgrade benchmarks against the eval set with these metrics:

| Metric | What it measures | Baseline (M0) | M6 target |
|---|---|---|---|
| `verifier_pass_rate` | % of eval tasks where verifier passes after pipeline runs | unknown | >80% |
| `merge_first_review_rate` | % where reviewer would approve without changes | unknown | >60% |
| `architect_tokens_per_task` | avg input tokens to architect role | unknown | -30-50% (M3+) |
| `cost_per_task` | avg USD spent per task (cost_usd in trace) | unknown | -25% (M6+) |
| `disagreement_rate` | % where verifier-pass but human-reviewer-reject | unknown | <25% |
| `false_positive_rate` | % where verifier-fail but task is actually correct | unknown | <10% |

Baselines are measured in M1.W1 by replaying the eval set against current IFleet.

## What NOT to include

- Tasks with secrets in diff (filter out — leak risk)
- Tasks where the merged PR was reverted within 7 days (signal pollution)
- Tasks merged by IFleet itself (avoid eval contamination if IFleet later trains on this)
- Tasks with >2000 LOC diff (too noisy for fingerprint comparison)
- Tasks with no test changes (can't verify behavioral correctness)

## Refresh policy

- **Add new tasks:** monthly, on the 1st. Append, never edit existing rows.
- **Remove tasks:** only if a row is later discovered to violate "what NOT to include" rules. Mark with `removed_reason` field, don't delete.
- **Versioning:** `frozen_at` timestamp on every row. Eval runs report against a snapshot tag.

## Privacy and storage

- Eval set lives in the IFleet repo, public. **Therefore: no client-repo tasks in it without explicit permission.** Bootstrap is internal repos only (IFleet, factory, voice-discovery, spec-template).
- Client-task eval lives in a separate private branch or external storage (decide M4 when client work starts).

## See also

- `docs/elevation/upgrades/10-self-improvement.md` — uses eval set as the shadow-eval gate
- `docs/elevation/operating-standard.md` — references eval set as the basis for "what we measure"
- `docs/adr/0001-single-trace-architecture.md` — trace events replayable against eval set
