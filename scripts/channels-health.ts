#!/usr/bin/env tsx
/**
 * `pnpm channels:health` — verifies every channels.json mapping is reachable.
 *
 * Exit code:
 *   0 — all channels reachable
 *   1 — at least one channel unreachable (auth failure, missing repo, etc.)
 *   2 — config error (channels.json missing/invalid)
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { FileChannelRouter } from '../src/repos/router.js';
import { GitRepoManager } from '../src/repos/manager.js';
import { RepoHealthChecker } from '../src/repos/health.js';

async function main(): Promise<void> {
  const configPath = resolve(process.env['IFLEET_CHANNELS_CONFIG'] ?? 'config/channels.json');
  const reposDir = process.env['IFLEET_REPOS_DIR'] ?? '/opt/ifleet/repos';
  const token = process.env['GITHUB_TOKEN'] ?? '';

  let router: FileChannelRouter;
  try {
    router = FileChannelRouter.fromFile(configPath, { reposDir });
  } catch (err) {
    console.error(`channels-health: failed to load ${configPath}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  if (!token) {
    console.error('channels-health: GITHUB_TOKEN not set — ls-remote will fail for private repos');
  }

  const manager = new GitRepoManager({ reposDir, token });
  const checker = new RepoHealthChecker(router, manager);
  const results = await checker.checkAll();

  const rows = results.map((r) => ({
    channelId: r.channelId,
    repo: r.repo,
    reachable: r.reachable,
    cloned: r.cloned,
    lastFetched: r.lastFetched ? new Date(r.lastFetched).toISOString() : '-',
    error: r.error ?? '',
  }));
  console.table(rows);

  const unreachable = results.filter((r) => !r.reachable);
  if (unreachable.length > 0) {
    console.error(`channels-health: ${unreachable.length} unreachable repo(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
