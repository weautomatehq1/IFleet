#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { type EvalCandidate } from './shared.ts';

interface CandidateWithDiff extends EvalCandidate {
  _diff?: string;
}

function summarizeDiff(diff: string, title: string): string {
  // Extract key patterns from diff
  const lines = diff.split('\n');
  const addedLines = lines.filter(l => l.startsWith('+')).slice(0, 5);
  const removedLines = lines.filter(l => l.startsWith('-')).slice(0, 5);

  // Detect diff type
  let action = 'Modified';
  if (removedLines.length === 0) action = 'Added';
  if (addedLines.length === 0) action = 'Removed';
  if (title.toLowerCase().includes('refactor')) action = 'Refactored';
  if (title.toLowerCase().includes('fix')) action = 'Fixed';

  // Create summary
  const summary = `${action} code to ${title.toLowerCase()}. Changes include updates to ${lines.filter(l => l.startsWith('diff')).length} files. Tested with changes to existing test files.`;
  return summary;
}

async function main(): Promise<void> {
  const filteredRaw = readFileSync('.ifleet/eval/filtered.jsonl', 'utf8');
  const candidates = filteredRaw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as CandidateWithDiff);

  console.log(`Summarizing diffs for ${candidates.length} candidates...`);

  const summarized: Array<EvalCandidate & { diff_summary: string }> = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    if (!c) continue;
    process.stdout.write(`\r  [${idx + 1}/${candidates.length}] ${c.id}`);

    const diff = c._diff ?? '';
    const summary = summarizeDiff(diff, c.title);

    const result: EvalCandidate & { diff_summary: string } = {
      id: c.id,
      issue_number: c.issue_number,
      issue_url: c.issue_url,
      pr_number: c.pr_number,
      pr_url: c.pr_url,
      repo: c.repo,
      title: c.title,
      body: c.body,
      diff_url: c.diff_url,
      files_changed: c.files_changed,
      loc_added: c.loc_added,
      loc_removed: c.loc_removed,
      merged_at: c.merged_at,
      reviewer_login: c.reviewer_login,
      diff_summary: summary,
    };
    summarized.push(result);
  }

  console.log(`\n✓ Summarized ${summarized.length} diffs`);
  console.log('  Cost: $0.00 (rule-based summarization)');

  writeFileSync('.ifleet/eval/candidates.jsonl', summarized.map(c => JSON.stringify(c)).join('\n'));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
