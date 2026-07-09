import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChannelRoute } from '../contracts/channel-router.js';
import { isGitDir, pathExists } from './fs-utils.js';

export interface RepoManager {
  /** Ensure the canonical clone exists at workDir/main. Clones if missing, fetches if exists. */
  ensureClone(route: ChannelRoute): Promise<{ path: string }>;
  /** Allocate a fresh git worktree for a task. */
  allocateWorktree(
    route: ChannelRoute,
    taskId: string,
    baseBranch?: string,
  ): Promise<{ path: string; branch: string }>;
  /** Tear down a worktree and (best-effort) the branch. Idempotent. */
  releaseWorktree(route: ChannelRoute, taskId: string): Promise<void>;
  /** `git fetch --prune` on the canonical clone. */
  sync(route: ChannelRoute): Promise<void>;
  /** `git ls-remote` against the route's remote — verifies auth + reachability. */
  lsRemote(route: ChannelRoute): Promise<void>;
}

export interface GitRepoManagerOptions {
  /**
   * Reserved for a future GC sweep that walks the repos directory. Today
   * path resolution flows through `route.workDir`, which the router sets
   * from the same env var (`IFLEET_REPOS_DIR`). Kept optional so callers
   * can keep passing it without breaking — the value is intentionally
   * unread.
   */
  reposDir?: string;
  /** GitHub token for HTTPS auth. Pass empty string for unauthenticated tests with file:// remotes. */
  token: string;
  /** Override the remote URL builder. Used by tests to point at file:// bare repos. */
  remoteUrlFor?: (route: ChannelRoute) => string;
  /** Override `git` binary (default: `git`). */
  gitBin?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitRepoManager implements RepoManager {
  private readonly token: string;
  private readonly remoteUrlFor: (route: ChannelRoute) => string;
  private readonly gitBin: string;
  private readonly perRepoLock = new Map<string, Promise<unknown>>();

  constructor(opts: GitRepoManagerOptions) {
    this.token = opts.token;
    this.gitBin = opts.gitBin ?? 'git';
    this.remoteUrlFor =
      opts.remoteUrlFor ??
      ((route) => `https://github.com/${route.repo}.git`);
  }

  canonicalPath(route: ChannelRoute): string {
    return join(route.workDir, 'main');
  }

  worktreePath(route: ChannelRoute, taskId: string): string {
    return join(route.workDir, 'worktrees', taskId);
  }

  branchName(taskId: string): string {
    return `ifleet/${taskId}`;
  }

  async ensureClone(route: ChannelRoute): Promise<{ path: string }> {
    return this.withLock(route.repo, async () => {
      const path = this.canonicalPath(route);
      if (await isGitDir(path)) {
        await this.runGit(['-C', path, 'fetch', '--prune', 'origin'], { withAuth: true });
        return { path };
      }
      await mkdir(dirname(path), { recursive: true });
      await this.runGit(
        ['clone', '--branch', route.defaultBranch, this.remoteUrlFor(route), path],
        { withAuth: true },
      );
      return { path };
    });
  }

  async sync(route: ChannelRoute): Promise<void> {
    await this.withLock(route.repo, async () => {
      const path = this.canonicalPath(route);
      await this.runGit(['-C', path, 'fetch', '--prune', 'origin'], { withAuth: true });
    });
  }

  async lsRemote(route: ChannelRoute): Promise<void> {
    await this.runGit(['ls-remote', '--heads', this.remoteUrlFor(route)], { withAuth: true });
  }

  async allocateWorktree(
    route: ChannelRoute,
    taskId: string,
    baseBranch?: string,
  ): Promise<{ path: string; branch: string }> {
    if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) {
      throw new Error(`allocateWorktree: invalid taskId ${JSON.stringify(taskId)}`);
    }
    await this.ensureClone(route);
    const canon = this.canonicalPath(route);
    const path = this.worktreePath(route, taskId);
    const branch = this.branchName(taskId);
    const base = baseBranch ?? `origin/${route.defaultBranch}`;
    await mkdir(dirname(path), { recursive: true });
    await this.runGit(['-C', canon, 'worktree', 'add', '-b', branch, path, base], {
      withAuth: false,
    });
    return { path, branch };
  }

  async releaseWorktree(route: ChannelRoute, taskId: string): Promise<void> {
    // Serialize against concurrent ensureClone/sync/allocateWorktree on the
    // same repo — git's worktree metadata is process-shared state.
    await this.withLock(route.repo, async () => {
      const canon = this.canonicalPath(route);
      const path = this.worktreePath(route, taskId);
      const branch = this.branchName(taskId);
      if (!(await isGitDir(canon))) return;
      // git worktree remove is idempotent-ish; --force handles dirty trees.
      const removed = await this.runGit(
        ['-C', canon, 'worktree', 'remove', '--force', path],
        { withAuth: false, allowFail: true },
      );
      // Stale entries: prune always.
      await this.runGit(['-C', canon, 'worktree', 'prune'], { withAuth: false, allowFail: true });
      // If physical path still exists, wipe it.
      if (await pathExists(path)) {
        await rm(path, { recursive: true, force: true });
      }
      // Drop the local branch if it has no upstream and is local-only.
      const branchProbe = await this.runGit(
        ['-C', canon, 'rev-parse', '--verify', `refs/heads/${branch}`],
        { withAuth: false, allowFail: true },
      );
      if (branchProbe.code === 0) {
        const upstream = await this.runGit(
          ['-C', canon, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
          { withAuth: false, allowFail: true },
        );
        if (upstream.code !== 0) {
          await this.runGit(['-C', canon, 'branch', '-D', branch], {
            withAuth: false,
            allowFail: true,
          });
        }
      }
      if (removed.code !== 0) {
        console.warn('[worktree] remove exited', removed.code, '— continuing cleanup');
      }
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.perRepoLock.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.perRepoLock.set(key, settled);
    // After this lock settles, drop the entry from the map IF nothing newer
    // has been chained on top of it. Without this the map grows unbounded
    // as new repos are introduced over a long-running daemon's lifetime.
    void settled.then(() => {
      if (this.perRepoLock.get(key) === settled) this.perRepoLock.delete(key);
    });
    return next;
  }

  private async runGit(
    args: string[],
    opts: { withAuth: boolean; allowFail?: boolean },
  ): Promise<RunResult> {
    const extraEnv = opts.withAuth && this.token ? this.authEnv() : undefined;
    const result = await spawnCapture(this.gitBin, args, extraEnv);
    if (!opts.allowFail && result.code !== 0) {
      // git can echo the Authorization header back under GIT_TRACE or when
      // a credential helper logs verbosely — scrub both stderr and stdout
      // before they end up inside a thrown Error that may be surfaced to
      // Discord or the event log.
      const stderr = redactToken(result.stderr.trim());
      const stdout = redactToken(result.stdout.trim());
      throw new Error(
        `git ${redactArgs(args).join(' ')} failed (code ${result.code}): ${stderr || stdout}`,
      );
    }
    return result;
  }

  private authEnv(): Record<string, string> {
    // Pass auth via GIT_CONFIG_* env vars (git >= 2.32) so the token never
    // appears in process argv visible to `ps`.
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${this.token}`,
    };
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const OUTPUT_CAP_BYTES = 2 * 1024 * 1024; // 2 MB — mirrors spawn-util.ts cap

// GIT_* vars that redirect the child git to a different repo or index.
// We strip only these, not all GIT_* — GIT_CONFIG_* (used for auth injection)
// and others must be allowed through.
const REROUTING_GIT_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

async function spawnCapture(bin: string, args: string[], extraEnv?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Strip only the vars that redirect git to operate on a different repo/index.
    // Leaving other GIT_* vars (e.g. GIT_CONFIG_*) intact so auth injection works.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !REROUTING_GIT_VARS.has(k))),
      ...extraEnv,
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < OUTPUT_CAP_BYTES) {
        const remaining = OUTPUT_CAP_BYTES - stdoutBytes;
        stdout += chunk.slice(0, remaining).toString('utf8');
        stdoutBytes += chunk.length;
        if (stdoutBytes >= OUTPUT_CAP_BYTES) stdout += '\n[stdout truncated]';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < OUTPUT_CAP_BYTES) {
        const remaining = OUTPUT_CAP_BYTES - stderrBytes;
        stderr += chunk.slice(0, remaining).toString('utf8');
        stderrBytes += chunk.length;
        if (stderrBytes >= OUTPUT_CAP_BYTES) stderr += '\n[stderr truncated]';
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Strip anything that looks like a bearer token from logged args. */
function redactArgs(args: string[]): string[] {
  return args.map((a) =>
    /AUTHORIZATION:\s*bearer/i.test(a) ? 'http.extraheader=AUTHORIZATION: bearer ***' : a,
  );
}

/**
 * Redact GitHub auth tokens that may have leaked into a process's stdout or
 * stderr (e.g. under GIT_TRACE) before the string is included in a thrown
 * Error or log line. Matches:
 *   - `Authorization: bearer <token>`
 *   - `x-access-token:<token>@host` style URLs (rare with --extraheader but
 *     possible when callers ever switch back to URL-embedded creds)
 */
export function redactToken(input: string): string {
  if (!input) return input;
  return input
    .replace(/bearer\s+[^\s"'`]+/gi, 'bearer ***')
    .replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
}
