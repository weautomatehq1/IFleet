import { stat } from 'node:fs/promises';
import type { ChannelRoute, ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import { isGitDir } from './fs-utils.js';
import type { GitRepoManager } from './manager.js';

export interface RepoHealthResult {
  channelId: string;
  repo: string;
  /** `git ls-remote` succeeded (auth OK, repo exists). */
  reachable: boolean;
  /** Local canonical clone exists with a `.git`. */
  cloned: boolean;
  /** Last FETCH_HEAD mtime as unix ms, null when never fetched. */
  lastFetched: number | null;
  error?: string;
}

export class RepoHealthChecker {
  constructor(
    private readonly router: ChannelRouter,
    private readonly manager: GitRepoManager,
  ) {}

  async checkAll(): Promise<RepoHealthResult[]> {
    return Promise.all(this.router.list().map((route) => this.checkOne(route)));
  }

  async checkOne(route: ChannelRoute): Promise<RepoHealthResult> {
    const canonical = this.manager.canonicalPath(route);
    const cloned = await isGitDir(canonical);
    const lastFetched = cloned ? await fetchHeadMtime(canonical) : null;
    try {
      await this.manager.lsRemote(route);
      return {
        channelId: route.channelId,
        repo: route.repo,
        reachable: true,
        cloned,
        lastFetched,
      };
    } catch (err) {
      return {
        channelId: route.channelId,
        repo: route.repo,
        reachable: false,
        cloned,
        lastFetched,
        error: errorMessage(err),
      };
    }
  }
}

async function fetchHeadMtime(canonical: string): Promise<number | null> {
  try {
    const s = await stat(`${canonical}/.git/FETCH_HEAD`);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
