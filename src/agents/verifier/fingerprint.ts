/**
 * Structural diff-hash for M4. Given a base/head ref pair on a real git repo,
 * compute a sha256 over a canonical per-file (path, addedLines, deletedLines)
 * shape. The hash is deterministic — same input pair, same hash forever — and
 * order-independent because we sort by path before hashing.
 *
 * Two PRs that touch the same files with the same +/- counts produce the same
 * fingerprint. Two PRs that differ by even one deleted line produce different
 * fingerprints. M4 PR-rejection learning keys off this fingerprint to detect
 * structural repeats across sprints.
 *
 * Security: we shell out to `git` via `execFile` (not `exec`) so the refs
 * cannot smuggle shell metacharacters. Refs are validated against a tight
 * regex before they reach the child process.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FingerprintInput {
  /** Absolute path to a git working tree. */
  repoRoot: string;
  /** Git ref (branch / tag / sha) of the base. */
  baseRef: string;
  /** Git ref (branch / tag / sha) of the head. */
  headRef: string;
}

export interface FingerprintResult {
  /** Lowercase hex sha256 over the sorted [{path, +, -}] payload. */
  sha256: string;
  /** Number of files in the diff (binary files are included with 0/0). */
  fileCount: number;
  /** Total lines added across all text files. Binary contributes 0. */
  addedLines: number;
  /** Total lines deleted across all text files. Binary contributes 0. */
  deletedLines: number;
}

interface FileDiff {
  path: string;
  addedLines: number;
  deletedLines: number;
}

const REF_RE = /^[A-Za-z0-9._/-]+$/;

function assertRef(label: string, ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) {
    throw new Error(`fingerprint: ${label} must be a non-empty string ≤256 chars`);
  }
  if (!REF_RE.test(ref)) {
    throw new Error(`fingerprint: ${label} contains disallowed characters: ${ref}`);
  }
}

/**
 * Parse one line of `git diff --numstat`. Format:
 *   `<added>\t<deleted>\t<path>`
 * Binary files report `-\t-\t<path>` — we coerce both counts to 0 and keep
 * the path so the fingerprint still reflects the structural change.
 */
function parseNumstatLine(line: string): FileDiff | null {
  if (line.length === 0) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const rawAdded = parts[0] ?? '';
  const rawDeleted = parts[1] ?? '';
  const path = parts.slice(2).join('\t');
  if (path.length === 0) return null;
  const added = rawAdded === '-' ? 0 : Number(rawAdded);
  const deleted = rawDeleted === '-' ? 0 : Number(rawDeleted);
  if (!Number.isFinite(added) || !Number.isFinite(deleted)) return null;
  return { path, addedLines: added, deletedLines: deleted };
}

export async function computeStructuralFingerprint(
  input: FingerprintInput,
): Promise<FingerprintResult> {
  assertRef('baseRef', input.baseRef);
  assertRef('headRef', input.headRef);
  if (typeof input.repoRoot !== 'string' || input.repoRoot.length === 0) {
    throw new Error('fingerprint: repoRoot must be a non-empty string');
  }

  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--numstat', `${input.baseRef}..${input.headRef}`],
    { cwd: input.repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );

  const files: FileDiff[] = [];
  for (const line of stdout.split('\n')) {
    const parsed = parseNumstatLine(line);
    if (parsed) files.push(parsed);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let addedLines = 0;
  let deletedLines = 0;
  for (const f of files) {
    addedLines += f.addedLines;
    deletedLines += f.deletedLines;
  }

  const payload = JSON.stringify(
    files.map((f) => ({ path: f.path, addedLines: f.addedLines, deletedLines: f.deletedLines })),
  );
  const sha256 = createHash('sha256').update(payload).digest('hex');

  return { sha256, fileCount: files.length, addedLines, deletedLines };
}
