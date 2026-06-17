import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanGitEnv } from '../../testing/git-env.js';
import { GitRepoManager, redactToken } from '../manager.js';
import type { ChannelRoute } from '../../contracts/channel-router.js';

let tmp: string;
let bareRepo: string;
let reposDir: string;
let route: ChannelRoute;

function git(cwd: string, ...args: string[]): void {
  // cleanGitEnv strips inherited GIT_* so spawned git uses cwd for repo
  // discovery, not the host repo via the pre-push hook. See src/testing/git-env.ts.
  const res = spawnSync('git', args, { cwd, stdio: 'pipe', env: cleanGitEnv });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString()}`);
  }
}

beforeAll(() => {
  // Sanity: git must be on PATH for these tests to be meaningful.
  const probe = spawnSync('git', ['--version']);
  if (probe.status !== 0) throw new Error('git not on PATH — manager tests require it');
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ifleet-mgr-'));
  reposDir = join(tmp, 'repos');
  mkdirSync(reposDir, { recursive: true });

  // Create a fake "remote" by initializing a seed repo and pushing to a bare clone.
  const seed = join(tmp, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '--initial-branch=main', '--quiet');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'README.md'), '# seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init', '--quiet');

  bareRepo = join(tmp, 'remote.git');
  git(seed, 'clone', '--bare', '--quiet', seed, bareRepo);

  route = {
    channelId: '111',
    repo: 'test/fake',
    workDir: join(reposDir, 'test-fake'),
    defaultBranch: 'main',
    defaultModel: 'opus',
    allowedUserIds: ['u1'],
    codeowners: ['@x'],
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function buildManager(): GitRepoManager {
  return new GitRepoManager({
    reposDir,
    token: '',
    remoteUrlFor: () => `file://${bareRepo}`,
  });
}

describe('GitRepoManager.ensureClone', () => {
  it('clones the remote on first call', async () => {
    const mgr = buildManager();
    const { path } = await mgr.ensureClone(route);
    expect(path).toBe(join(route.workDir, 'main'));
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('seed');
  });

  it('is idempotent and fetches when re-called', async () => {
    const mgr = buildManager();
    await mgr.ensureClone(route);
    // Should not throw and should still resolve to the same path.
    const { path } = await mgr.ensureClone(route);
    expect(existsSync(join(path, '.git'))).toBe(true);
  });

  it('serializes concurrent calls per repo (no race)', async () => {
    const mgr = buildManager();
    const results = await Promise.all([
      mgr.ensureClone(route),
      mgr.ensureClone(route),
      mgr.ensureClone(route),
    ]);
    for (const r of results) {
      expect(r.path).toBe(join(route.workDir, 'main'));
    }
  });
});

describe('GitRepoManager worktree lifecycle', () => {
  it('allocates a worktree, accepts a write, then releases cleanly', async () => {
    const mgr = buildManager();
    const { path, branch } = await mgr.allocateWorktree(route, 'task-abc');
    expect(branch).toBe('ifleet/task-abc');
    expect(existsSync(path)).toBe(true);

    // Editor would write into the worktree:
    writeFileSync(join(path, 'hello.txt'), 'hi\n');
    expect(existsSync(join(path, 'hello.txt'))).toBe(true);

    await mgr.releaseWorktree(route, 'task-abc');
    expect(existsSync(path)).toBe(false);
  });

  it('rejects invalid taskIds', async () => {
    const mgr = buildManager();
    await expect(mgr.allocateWorktree(route, '../escape')).rejects.toThrow(/invalid taskId/);
  });

  it('releaseWorktree is idempotent (safe on missing worktree)', async () => {
    const mgr = buildManager();
    await mgr.ensureClone(route);
    await expect(mgr.releaseWorktree(route, 'never-allocated')).resolves.toBeUndefined();
  });

  it('release after release does not throw', async () => {
    const mgr = buildManager();
    await mgr.allocateWorktree(route, 'twice');
    await mgr.releaseWorktree(route, 'twice');
    await expect(mgr.releaseWorktree(route, 'twice')).resolves.toBeUndefined();
  });
});

describe('HIGH-5: redactToken', () => {
  it('redacts bearer tokens echoed in git stderr', () => {
    const stderr =
      'fatal: unable to access ...\nrun-command: Authorization: bearer ghp_realtoken_xyz123\nmore noise';
    const redacted = redactToken(stderr);
    expect(redacted).not.toContain('ghp_realtoken_xyz123');
    expect(redacted).toContain('bearer ***');
  });

  it('redacts x-access-token URL credentials too', () => {
    const stderr = 'remote: https://x-access-token:ghp_abc@github.com/o/r refused';
    const redacted = redactToken(stderr);
    expect(redacted).not.toContain('ghp_abc');
    expect(redacted).toContain('x-access-token:***@');
  });

  it('is a no-op for clean strings', () => {
    expect(redactToken('nothing to redact here')).toBe('nothing to redact here');
    expect(redactToken('')).toBe('');
  });
});

describe('GitRepoManager.lsRemote', () => {
  it('succeeds for a reachable remote', async () => {
    const mgr = buildManager();
    await expect(mgr.lsRemote(route)).resolves.toBeUndefined();
  });

  it('throws for an unreachable remote', async () => {
    const mgr = new GitRepoManager({
      reposDir,
      token: '',
      remoteUrlFor: () => `file://${tmp}/does-not-exist`,
    });
    await expect(mgr.lsRemote(route)).rejects.toThrow();
  });
});
