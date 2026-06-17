#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type EvalCandidate,
  hasSecrets,
  hasTestFileChange,
} from './shared.ts';

const exec = promisify(execFile);

interface CandidateWithDiff extends EvalCandidate {
  _diff?: string;
}

interface FilterResult {
  candidate: EvalCandidate;
  diff: string;
}

interface RevertablePR {
  number: number;
  title: string;
  mergedAt: string;
}

// Pre-fetch every merged PR per repo ONCE, then detect reverts in-memory. The
// previous implementation issued one `gh pr list --search` per candidate; at the
// widened source size (300+ PRs) that is 300+ API round-trips. Batching keeps the
// revert filter semantically identical (a PR whose title reverts #N and merged
// within 7 days of N's merge) while collapsing it to one call per repo.
async function fetchAllMergedPRs(repo: string): Promise<RevertablePR[]> {
  const { stdout } = await exec('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '500',
    '--json',
    'number,title,mergedAt',
  ]);
  try {
    return (JSON.parse(stdout) as RevertablePR[]).filter(p => p.mergedAt);
  } catch {
    return [];
  }
}

function wasReverted(
  prNumber: number,
  mergedAt: string,
  repoPRs: RevertablePR[],
): boolean {
  const mergedDate = new Date(mergedAt).getTime();
  const sevenDaysLater = mergedDate + 7 * 24 * 60 * 60 * 1000;
  const revertPatterns = [
    new RegExp(`revert.*#${prNumber}\\b`, 'i'),
    new RegExp(`revert.*"${prNumber}"`, 'i'),
  ];
  return repoPRs.some(p => {
    const t = new Date(p.mergedAt).getTime();
    if (t < mergedDate || t > sevenDaysLater) return false;
    return revertPatterns.some(rx => rx.test(p.title));
  });
}

function isBot(login: string): boolean {
  return login.includes('bot') || login.includes('[bot]') || login === 'ifleet';
}

async function main(): Promise<void> {
  const linkedRaw = readFileSync('.ifleet/eval/linked.jsonl', 'utf8');
  const candidates = linkedRaw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as CandidateWithDiff);

  console.log(`Processing ${candidates.length} linked candidates...`);

  // One revert-index fetch per distinct repo.
  const repos = Array.from(new Set(candidates.map(c => c.repo)));
  const revertIndex = new Map<string, RevertablePR[]>();
  for (const repo of repos) {
    revertIndex.set(repo, await fetchAllMergedPRs(repo));
  }

  const filtered: FilterResult[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    process.stdout.write(`\r  [${i + 1}/${candidates.length}] ${c.id}        `);

    // Reuse the diff embedded by the link stage (single fetch per PR upstream).
    const diff = c._diff ?? '';

    // Filter 1: has secrets? Scan both the diff AND the task-description body —
    // the body is persisted verbatim into the eval row, so a secret-shaped string
    // there (even a placeholder like TOKEN=...) would corrupt a holdout meant to
    // be clean. This strengthens the spec's diff-only secret filter; it never
    // relaxes it.
    if (hasSecrets(diff) || hasSecrets(c.body)) {
      excluded.push({ id: c.id, reason: 'contains_secrets' });
      continue;
    }

    // Filter 2: LOC < 2000?
    if (c.loc_added + c.loc_removed > 2000) {
      excluded.push({ id: c.id, reason: 'too_large' });
      continue;
    }

    // Filter 3: has test file change?
    if (!hasTestFileChange(c.files_changed)) {
      excluded.push({ id: c.id, reason: 'no_test_changes' });
      continue;
    }

    // Filter 4: not reverted within 7 days?
    if (wasReverted(c.pr_number, c.merged_at, revertIndex.get(c.repo) ?? [])) {
      excluded.push({ id: c.id, reason: 'reverted_within_7d' });
      continue;
    }

    // Filter 5: not authored by a bot?
    if (isBot(c.reviewer_login)) {
      excluded.push({ id: c.id, reason: 'bot_authored' });
      continue;
    }

    // Strip the transient _diff from the persisted candidate; re-attach as _diff
    // for the downstream summarize stage exactly as before.
    const { _diff: _omit, ...clean } = c;
    void _omit;
    filtered.push({ candidate: clean, diff });
  }

  console.log(`\n✓ Filtered to ${filtered.length} evaluable candidates`);
  console.log(`✗ Excluded ${excluded.length}:`);
  const byReason: Record<string, number> = {};
  for (const e of excluded) {
    byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  }
  for (const [reason, count] of Object.entries(byReason).sort()) {
    console.log(`  - ${reason}: ${count}`);
  }

  writeFileSync(
    '.ifleet/eval/filtered.jsonl',
    filtered.map(f => JSON.stringify({ ...f.candidate, _diff: f.diff })).join('\n'),
  );
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
