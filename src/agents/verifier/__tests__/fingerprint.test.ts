import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanGitEnv } from '../../../testing/git-env.js';
import { computeStructuralFingerprint } from '../fingerprint.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    // Full GIT_* scrub so temp-repo commits don't leak into the parent repo
    // when this test runs inside the git push hook. The previous version unset
    // only GIT_DIR/GIT_WORK_TREE and missed GIT_INDEX_FILE (also exported by
    // `git push`); cleanGitEnv strips every GIT_* var. See src/testing/git-env.ts.
    env: {
      ...cleanGitEnv,
      GIT_AUTHOR_NAME: 't2-fingerprint-test',
      GIT_AUTHOR_EMAIL: 't2@example.com',
      GIT_COMMITTER_NAME: 't2-fingerprint-test',
      GIT_COMMITTER_EMAIL: 't2@example.com',
    },
  });
}

interface RepoSetup {
  root: string;
  baseSha: string;
  cleanup: () => void;
}

async function makeRepoWithBaseCommit(): Promise<RepoSetup> {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-test-'));
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'base');
  const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  return {
    root,
    baseSha: shaOut.trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('computeStructuralFingerprint', () => {
  let repo: RepoSetup;
  // Save and restore GIT_DIR / GIT_WORK_TREE around every test so that
  // computeStructuralFingerprint's internal git spawns use cwd-discovery
  // rather than the parent repo's git dir (which git sets before pre-push hooks).
  let savedGitDir: string | undefined;
  let savedGitWorkTree: string | undefined;

  beforeEach(async () => {
    savedGitDir = process.env['GIT_DIR'];
    savedGitWorkTree = process.env['GIT_WORK_TREE'];
    delete process.env['GIT_DIR'];
    delete process.env['GIT_WORK_TREE'];
    repo = await makeRepoWithBaseCommit();
  });

  afterEach(() => {
    if (savedGitDir !== undefined) process.env['GIT_DIR'] = savedGitDir;
    else delete process.env['GIT_DIR'];
    if (savedGitWorkTree !== undefined) process.env['GIT_WORK_TREE'] = savedGitWorkTree;
    else delete process.env['GIT_WORK_TREE'];
    repo.cleanup();
  });

  it('is deterministic — same input twice → same hash', async () => {
    writeFileSync(join(repo.root, 'a.txt'), 'line1\nline2\nline3\n');
    mkdirSync(join(repo.root, 'sub'), { recursive: true });
    writeFileSync(join(repo.root, 'sub', 'b.txt'), 'x\ny\n');
    await git(repo.root, 'add', '.');
    await git(repo.root, 'commit', '-q', '-m', 'feature');

    const first = await computeStructuralFingerprint({
      repoRoot: repo.root,
      baseRef: repo.baseSha,
      headRef: 'HEAD',
    });
    const second = await computeStructuralFingerprint({
      repoRoot: repo.root,
      baseRef: repo.baseSha,
      headRef: 'HEAD',
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.fileCount).toBe(2);
    expect(first.addedLines).toBe(5);
    expect(first.deletedLines).toBe(0);
  });

  it('is order-independent — files added in either order produce the same hash', async () => {
    // Branch A: create a.txt first then b.txt — same numstat output regardless
    // of physical order, because computeStructuralFingerprint sorts by path
    // before hashing. We simulate the permutation by committing files in
    // different orders on two branches.
    await git(repo.root, 'checkout', '-q', '-b', 'order-a');
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    await git(repo.root, 'add', 'a.txt');
    await git(repo.root, 'commit', '-q', '-m', 'a');
    writeFileSync(join(repo.root, 'b.txt'), '2\n2\n');
    await git(repo.root, 'add', 'b.txt');
    await git(repo.root, 'commit', '-q', '-m', 'b');
    const hashA = (
      await computeStructuralFingerprint({
        repoRoot: repo.root,
        baseRef: repo.baseSha,
        headRef: 'HEAD',
      })
    ).sha256;

    await git(repo.root, 'checkout', '-q', repo.baseSha);
    await git(repo.root, 'checkout', '-q', '-b', 'order-b');
    writeFileSync(join(repo.root, 'b.txt'), '2\n2\n');
    await git(repo.root, 'add', 'b.txt');
    await git(repo.root, 'commit', '-q', '-m', 'b');
    writeFileSync(join(repo.root, 'a.txt'), '1\n');
    await git(repo.root, 'add', 'a.txt');
    await git(repo.root, 'commit', '-q', '-m', 'a');
    const hashB = (
      await computeStructuralFingerprint({
        repoRoot: repo.root,
        baseRef: repo.baseSha,
        headRef: 'HEAD',
      })
    ).sha256;

    expect(hashA).toBe(hashB);
  });

  it('is sensitive — one extra deleted line flips the hash', async () => {
    writeFileSync(join(repo.root, 'README.md'), 'base\nextra1\nextra2\n');
    await git(repo.root, 'add', '.');
    await git(repo.root, 'commit', '-q', '-m', 'add lines');
    const before = await computeStructuralFingerprint({
      repoRoot: repo.root,
      baseRef: repo.baseSha,
      headRef: 'HEAD',
    });

    await git(repo.root, 'checkout', '-q', repo.baseSha);
    await git(repo.root, 'checkout', '-q', '-b', 'with-delete');
    // base had `base\n`; new content drops it AND adds extras → one extra
    // deleted line vs. the previous branch.
    writeFileSync(join(repo.root, 'README.md'), 'extra1\nextra2\n');
    await git(repo.root, 'add', '.');
    await git(repo.root, 'commit', '-q', '-m', 'add lines and delete base');
    const after = await computeStructuralFingerprint({
      repoRoot: repo.root,
      baseRef: repo.baseSha,
      headRef: 'HEAD',
    });

    expect(after.sha256).not.toBe(before.sha256);
    expect(after.deletedLines).toBeGreaterThan(before.deletedLines);
  });

  it('rejects refs that smuggle shell metacharacters', async () => {
    await expect(
      computeStructuralFingerprint({
        repoRoot: repo.root,
        baseRef: 'main; rm -rf /',
        headRef: 'HEAD',
      }),
    ).rejects.toThrow(/disallowed characters/);
    await expect(
      computeStructuralFingerprint({
        repoRoot: repo.root,
        baseRef: 'main',
        headRef: '$(whoami)',
      }),
    ).rejects.toThrow(/disallowed characters/);
  });
});
