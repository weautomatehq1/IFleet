import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface IssueRow {
  number: number;
  title: string;
  body: string;
  url: string;
  closedAt: string;
  labels: Array<{ name: string }>;
  repo: string;
}

export interface PRRow {
  number: number;
  title: string;
  mergedAt: string;
  url: string;
  repo: string;
  diffUrl: string;
  mergedBy?: { login: string };
}

export interface EvalCandidate {
  id: string;
  issue_number: number;
  issue_url: string;
  pr_number: number;
  pr_url: string;
  repo: string;
  title: string;
  body: string;
  diff_url: string;
  merged_at: string;
  reviewer_login: string;
  files_changed: string[];
  loc_added: number;
  loc_removed: number;
  diff_summary?: string;
}

export interface EvalRow {
  id: string;
  issue_url: string;
  pr_url: string;
  repo: string;
  title: string;
  body: string;
  classifier_label_actual: string;
  diff_url: string;
  diff_summary: string;
  files_changed: string[];
  loc_added: number;
  loc_removed: number;
  merged_at: string;
  reviewer_login: string;
  merge_decision: 'merged_no_changes' | 'merged_after_changes';
  frozen_at: string;
}

export async function gh(args: string[], json = false): Promise<string> {
  const { stdout } = await exec('gh', [...args, ...(json ? ['--json'] : [])]);
  return stdout;
}

export function parseIssuesJSON(raw: string): IssueRow[] {
  try {
    return JSON.parse(raw);
  } catch {
    console.error('Failed to parse issues JSON:', raw);
    return [];
  }
}

export function parsePRsJSON(raw: string): PRRow[] {
  try {
    return JSON.parse(raw);
  } catch {
    console.error('Failed to parse PRs JSON:', raw);
    return [];
  }
}

export function extractFixesCloses(prBody: string): number[] {
  const regex = /(?:fixes|closes|resolves|fixed|closed|resolved)\s+#(\d+)/gi;
  const matches = Array.from(prBody.matchAll(regex));
  return matches.map(m => parseInt(m[1] ?? '0', 10)).filter(n => n > 0);
}

export function hasSecrets(diff: string): boolean {
  const secretPatterns = [
    /(?:api[_-]?key|password|secret|token|auth|credential)[=:]/i,
    /(?:sk_[a-z]{2}_|pk_[a-z]{2}_)\w+/i,
    /-----BEGIN RSA PRIVATE KEY-----/,
    /-----BEGIN PRIVATE KEY-----/,
  ];
  return secretPatterns.some(p => p.test(diff));
}

export function countLoC(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n');
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export function extractFilesChanged(diff: string): string[] {
  const lines = diff.split('\n');
  const files = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const match = line.match(/^diff --git a\/(.*) b\/.*$/);
      if (match && match[1]) files.add(match[1]);
    }
  }
  return Array.from(files);
}

export function hasTestFileChange(files: string[]): boolean {
  return files.some(f =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) ||
    /^\/?(__tests__|test|tests)\/.+\.(ts|tsx|js|jsx)$/.test(f),
  );
}

export function genID(repo: string, issueNumber: number): string {
  const parts = repo.split('/');
  const repoName = parts[1] ?? 'UNKNOWN';
  const repoPrefix = repoName.substring(0, 2).toUpperCase();
  return `ifleet-${repoPrefix}-${String(issueNumber).padStart(3, '0')}`;
}
