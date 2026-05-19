#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyPR } from './classify.ts';
import { type EvalCandidate, type EvalRow } from './shared.ts';

interface CandidateWithSummary extends EvalCandidate {
  diff_summary: string;
}

async function main(): Promise<void> {
  const candidatesRaw = readFileSync('.ifleet/eval/candidates.jsonl', 'utf8');
  const candidates = candidatesRaw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as CandidateWithSummary);

  console.log(`Freezing ${candidates.length} candidates...`);

  const frozen: EvalRow[] = candidates.map((c) => ({
    id: c.id,
    issue_url: c.issue_url,
    pr_url: c.pr_url,
    repo: c.repo,
    title: c.title,
    body: c.body,
    classifier_label_actual: classifyPR(c.title, c.body),
    diff_url: c.diff_url,
    diff_summary: c.diff_summary,
    files_changed: c.files_changed,
    loc_added: c.loc_added,
    loc_removed: c.loc_removed,
    merged_at: c.merged_at,
    reviewer_login: c.reviewer_login,
    merge_decision: 'merged_no_changes' as const,
    frozen_at: new Date().toISOString(),
  }));

  writeFileSync('.ifleet/eval/eval-set.jsonl', frozen.map(r => JSON.stringify(r)).join('\n'));
  console.log(`✓ Frozen ${frozen.length} rows to .ifleet/eval/eval-set.jsonl`);
  console.log(`\nBreakdown by repo:`);
  const byRepo: Record<string, number> = {};
  for (const row of frozen) {
    byRepo[row.repo] = (byRepo[row.repo] ?? 0) + 1;
  }
  for (const [repo, count] of Object.entries(byRepo).sort()) {
    console.log(`  - ${repo}: ${count}`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
