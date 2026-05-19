#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  type IssueRow,
  type PRRow,
  type EvalCandidate,
  extractFixesCloses,
  parseIssuesJSON,
  countLoC,
  extractFilesChanged,
  genID,
} from './shared.ts';

const exec = promisify(execFile);

async function fetchMergedPRsWithBodies(repo: string): Promise<Array<PRRow & { body: string }>> {
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
  const prs = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    mergedAt: string;
    url: string;
    body: string;
    mergedBy?: { login: string };
  }>;
  return prs.map(pr => ({
    ...pr,
    repo,
    diffUrl: `https://patch-diff.githubusercontent.com/raw/${repo}/pull/${pr.number}.diff`,
  }));
}

async function main(): Promise<void> {
  const candidates: EvalCandidate[] = [];
  const issuesDir = '.ifleet/eval/raw';
  const files = readdirSync(issuesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const repo = file.replace('weautomatehq1_', 'weautomatehq1/').replace('.json', '');
    console.log(`\nLinking issues to PRs for ${repo}...`);

    const issuesRaw = readFileSync(`${issuesDir}/${file}`, 'utf8');
    const issues = parseIssuesJSON(issuesRaw) as IssueRow[];
    console.log(`  Found ${issues.length} closed issues`);

    // Fetch all merged PRs at once
    const prs = await fetchMergedPRsWithBodies(repo);
    console.log(`  → Found ${prs.length} merged PRs`);

    // Build map of issue # to PRs that fix it
    const issueFixMap = new Map<number, PRRow & { body: string }>();
    for (const pr of prs) {
      const fixedIssues = extractFixesCloses(pr.body);
      for (const issueNum of fixedIssues) {
        if (!issueFixMap.has(issueNum)) {
          issueFixMap.set(issueNum, pr);
        }
      }
    }

    // Link issues to PRs
    for (const issue of issues) {
      const linkedPR = issueFixMap.get(issue.number);
      if (!linkedPR) continue;

      // Fetch the diff
      const { stdout: diffRaw } = await exec('curl', ['-s', linkedPR.diffUrl]);
      const diff = diffRaw;

      // Extract metrics
      const { added, removed } = countLoC(diff);
      const changedFiles = extractFilesChanged(diff);

      candidates.push({
        id: genID(repo, issue.number),
        issue_number: issue.number,
        issue_url: issue.url,
        pr_number: linkedPR.number,
        pr_url: linkedPR.url,
        repo,
        title: linkedPR.title,
        body: issue.body,
        diff_url: linkedPR.diffUrl,
        merged_at: linkedPR.mergedAt,
        reviewer_login: linkedPR.mergedBy?.login || 'unknown',
        files_changed: changedFiles,
        loc_added: added,
        loc_removed: removed,
      });
    }
  }

  writeFileSync('.ifleet/eval/linked.jsonl', candidates.map(c => JSON.stringify(c)).join('\n'));
  console.log(`\n✓ Linked ${candidates.length} issues to PRs → .ifleet/eval/linked.jsonl`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
