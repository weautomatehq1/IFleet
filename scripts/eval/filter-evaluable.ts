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

interface FilterResult {
  candidate: EvalCandidate;
  diff: string;
  reason?: string;
}

async function getPRDiff(repo: string, prNumber: number): Promise<string> {
  const url = `https://patch-diff.githubusercontent.com/raw/${repo}/pull/${prNumber}.diff`;
  const { stdout } = await exec('curl', ['-s', url]);
  return stdout;
}

async function checkReverted(repo: string, prNumber: number, mergedAt: string): Promise<boolean> {
  const mergedDate = new Date(mergedAt);
  const sevenDaysLater = new Date(mergedDate.getTime() + 7 * 24 * 60 * 60 * 1000);

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
    '--search',
    `merged:${mergedAt.split('T')[0]}..${sevenDaysLater.toISOString().split('T')[0]}`,
  ]);

  try {
    const prs = JSON.parse(stdout) as Array<{ title: string }>;
    const revertPatterns = [
      new RegExp(`revert.*#${prNumber}`, 'i'),
      new RegExp(`revert.*"${prNumber}"`, 'i'),
    ];
    return prs.some(pr => revertPatterns.some(p => p.test(pr.title)));
  } catch {
    return false;
  }
}

async function isBot(login: string): Promise<boolean> {
  return login.includes('bot') || login.includes('[bot]') || login === 'ifleet';
}

async function main(): Promise<void> {
  const linkedRaw = readFileSync('.ifleet/eval/linked.jsonl', 'utf8');
  const candidates = linkedRaw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as EvalCandidate);

  console.log(`Processing ${candidates.length} linked candidates...`);

  const filtered: FilterResult[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];

  for (const c of candidates) {
    process.stdout.write(`\r  [${candidates.indexOf(c) + 1}/${candidates.length}] ${c.id}`);

    // Fetch diff
    const diff = await getPRDiff(c.repo, c.pr_number);

    // Filter 1: has secrets?
    if (hasSecrets(diff)) {
      excluded.push({ id: c.id, reason: 'contains_secrets' });
      continue;
    }

    // Filter 2: LOC < 2000?
    const totalLoc = c.loc_added + c.loc_removed;
    if (totalLoc > 2000) {
      excluded.push({ id: c.id, reason: 'too_large' });
      continue;
    }

    // Filter 3: has test file change?
    if (!hasTestFileChange(c.files_changed)) {
      excluded.push({ id: c.id, reason: 'no_test_changes' });
      continue;
    }

    // Filter 4: not reverted?
    if (await checkReverted(c.repo, c.pr_number, c.merged_at)) {
      excluded.push({ id: c.id, reason: 'reverted_within_7d' });
      continue;
    }

    // Filter 5: not authored by bot?
    if (await isBot(c.reviewer_login)) {
      excluded.push({ id: c.id, reason: 'bot_authored' });
      continue;
    }

    filtered.push({ candidate: c, diff });
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
