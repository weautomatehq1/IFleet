import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileChannelRouter } from '../router.js';
import { GitRepoManager } from '../manager.js';
import { RepoHealthChecker } from '../health.js';

let tmp: string;
let reposDir: string;
let bareRepo: string;
let channelsPath: string;

function git(cwd: string, ...args: string[]): void {
  // Strip git hook env vars so spawned processes use cwd for repo discovery.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const res = spawnSync('git', args, { cwd, stdio: 'pipe', env });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ifleet-health-'));
  reposDir = join(tmp, 'repos');
  mkdirSync(reposDir, { recursive: true });

  // Build one reachable bare remote.
  const seed = join(tmp, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main', '--quiet');
  git(seed, 'config', 'user.email', 't@e');
  git(seed, 'config', 'user.name', 't');
  git(seed, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(seed, 'a'), '');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'x', '--quiet');
  bareRepo = join(tmp, 'remote.git');
  git(seed, 'clone', '--bare', '--quiet', seed, bareRepo);

  channelsPath = join(tmp, 'channels.json');
  writeFileSync(
    channelsPath,
    JSON.stringify({
      version: 1,
      channels: [
        {
          channelId: '111111111111111111',
          name: 'ok',
          repo: 'test/ok',
          defaultBranch: 'main',
          defaultModel: 'opus',
          allowedUserIds: ['u'],
          codeowners: ['@u'],
        },
        {
          channelId: '222222222222222222',
          name: 'missing',
          repo: 'test/missing',
          defaultBranch: 'main',
          defaultModel: 'sonnet',
          allowedUserIds: ['u'],
          codeowners: ['@u'],
        },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('RepoHealthChecker', () => {
  it('reports reachable=true for working remote and false for missing one', async () => {
    const router = FileChannelRouter.fromFile(channelsPath, { reposDir });
    const manager = new GitRepoManager({
      token: '',
      remoteUrlFor: (route) =>
        route.repo === 'test/ok' ? `file://${bareRepo}` : `file://${tmp}/nope`,
    });
    const checker = new RepoHealthChecker(router, manager);
    const results = await checker.checkAll();
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.repo === 'test/ok')!;
    const missing = results.find((r) => r.repo === 'test/missing')!;
    expect(ok.reachable).toBe(true);
    expect(ok.cloned).toBe(false);
    expect(ok.lastFetched).toBeNull();
    expect(missing.reachable).toBe(false);
    expect(missing.error).toBeTruthy();
  });

  it('reports cloned + lastFetched once ensureClone runs', async () => {
    const router = FileChannelRouter.fromFile(channelsPath, { reposDir });
    const manager = new GitRepoManager({
      token: '',
      remoteUrlFor: () => `file://${bareRepo}`,
    });
    const route = router.resolve('111111111111111111')!;
    const { path: repoPath } = await manager.ensureClone(route);
    // Write FETCH_HEAD directly — manager.sync inherits GIT_DIR from the
    // pre-push hook env and fetches into the wrong repo, leaving it absent.
    writeFileSync(join(repoPath, '.git', 'FETCH_HEAD'), '');
    const checker = new RepoHealthChecker(router, manager);
    const result = await checker.checkOne(route);
    expect(result.reachable).toBe(true);
    expect(result.cloned).toBe(true);
    expect(typeof result.lastFetched).toBe('number');
  });
});
