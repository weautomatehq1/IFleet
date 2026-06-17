#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  type IssueRow,
  type EvalCandidate,
  extractFixesCloses,
  parseIssuesJSON,
  countLoC,
  extractFilesChanged,
} from './shared.ts';

const exec = promisify(execFile);

interface MergedPR {
  number: number;
  title: string;
  mergedAt: string;
  url: string;
  body: string;
  mergedBy?: { login: string };
}

// Source the candidate pool from ALL qualifying merged PRs, not just the small
// subset that happens to carry a `fixes/closes #N` back-link to a closed issue.
// IFleet has 300+ merged PRs but only ~30 closed issues, so issue-linking alone
// starves the eval set far below the ≥50-row gate. Widening the SOURCE here does
// not touch any safety filter — every candidate emitted still flows through the
// full filter-evaluable.ts gauntlet (secrets / LOC / test-file / revert / bot).
async function fetchMergedPRs(repo: string): Promise<MergedPR[]> {
  const { stdout } = await exec('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    '500',
    '--json',
    'number,title,mergedAt,url,mergedBy,body',
  ]);
  return JSON.parse(stdout) as MergedPR[];
}

async function fetchDiff(repo: string, prNumber: number): Promise<string> {
  // Authenticated diff fetch (gh API, 5000/hr) — more reliable at this volume
  // than unauthenticated curl against the patch-diff redirect service.
  try {
    const { stdout } = await exec('gh', ['pr', 'diff', String(prNumber), '--repo', repo], {
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

function genPRID(repo: string, prNumber: number): string {
  const repoName = repo.split('/')[1] ?? 'UNKNOWN';
  const prefix = repoName.substring(0, 2).toUpperCase();
  return `ifleet-${prefix}-pr${String(prNumber).padStart(4, '0')}`;
}

async function main(): Promise<void> {
  const candidates: Array<EvalCandidate & { _diff: string }> = [];
  const issuesDir = '.ifleet/eval/raw';
  const files = readdirSync(issuesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const repo = file.replace('weautomatehq1_', 'weautomatehq1/').replace('.json', '');
    console.log(`\nSourcing merged PRs for ${repo}...`);

    // Build issue lookup so issue-linked PRs keep their real issue_url + body.
    const issuesRaw = readFileSync(`${issuesDir}/${file}`, 'utf8');
    const issues = parseIssuesJSON(issuesRaw) as IssueRow[];
    const issueMap = new Map<number, IssueRow>();
    for (const issue of issues) issueMap.set(issue.number, issue);

    const prs = await fetchMergedPRs(repo);
    console.log(`  → ${prs.length} merged PRs, ${issues.length} closed issues`);

    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      if (!pr) continue;
      process.stdout.write(`\r  [${i + 1}/${prs.length}] PR #${pr.number}        `);

      const diff = await fetchDiff(repo, pr.number);
      if (!diff.trim()) continue; // empty/binary-only diff — nothing to evaluate

      const { added, removed } = countLoC(diff);
      const changedFiles = extractFilesChanged(diff);
      if (changedFiles.length === 0) continue;

      // Prefer a real linked issue for the task description; fall back to PR body.
      const linkedIssueNum = extractFixesCloses(pr.body)[0];
      const linkedIssue = linkedIssueNum != null ? issueMap.get(linkedIssueNum) : undefined;

      candidates.push({
        id: genPRID(repo, pr.number),
        issue_number: linkedIssue?.number ?? 0,
        issue_url: linkedIssue?.url ?? '',
        pr_number: pr.number,
        pr_url: pr.url,
        repo,
        title: pr.title,
        body: linkedIssue?.body ?? pr.body ?? '',
        diff_url: `https://patch-diff.githubusercontent.com/raw/${repo}/pull/${pr.number}.diff`,
        merged_at: pr.mergedAt,
        reviewer_login: pr.mergedBy?.login || 'unknown',
        files_changed: changedFiles,
        loc_added: added,
        loc_removed: removed,
        _diff: diff,
      });
    }
    process.stdout.write('\n');
  }

  writeFileSync('.ifleet/eval/linked.jsonl', candidates.map(c => JSON.stringify(c)).join('\n'));
  console.log(`\n✓ Sourced ${candidates.length} merged-PR candidates → .ifleet/eval/linked.jsonl`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
