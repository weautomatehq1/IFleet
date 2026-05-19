# Private Evaluation Set

This directory contains the private evaluation set used to measure IFleet's performance across the 6-month elevation roadmap.

## Files

- `eval-set.jsonl` — The frozen evaluation set with ≥50 tasks per spec
- `raw/` — Intermediate dumps (not committed)
- Other intermediate files (`linked.jsonl`, `filtered.jsonl`, `candidates.jsonl`) — cleared after each run

## Refresh workflow (monthly)

To refresh the evaluation set with new tasks:

```bash
pnpm eval:bootstrap
```

This runs the full pipeline: dump issues → link to PRs → filter → summarize with Haiku → freeze.

## Schema

Each row in `eval-set.jsonl` follows:

```json
{
  "id": "ifleet-IF-001",
  "issue_url": "...",
  "pr_url": "...",
  "repo": "weautomatehq1/IFleet",
  "title": "...",
  "body": "...",
  "classifier_label_actual": "feature|bugfix|refactor|docs",
  "diff_url": "...",
  "diff_summary": "<3-sentence LLM summary>",
  "files_changed": ["..."],
  "loc_added": 123,
  "loc_removed": 45,
  "merged_at": "2026-05-19T13:11:00Z",
  "reviewer_login": "sebastianpuig",
  "merge_decision": "merged_no_changes",
  "frozen_at": "2026-05-19T00:00:00Z"
}
```

## Filter criteria

Only tasks that meet ALL of these criteria are included:

- No secrets in diff
- Diff <2000 LOC (lines added + removed)
- At least one test file changed
- Not reverted within 7 days of merge
- Not authored by a bot

## Metrics tracked per upgrade

See `docs/elevation/eval-set.md` for the full list of metrics and targets.

## Cost

Haiku diff summarization costs ~$0.01–$0.03 per task (~$1–$3 per 100-task bootstrap).
