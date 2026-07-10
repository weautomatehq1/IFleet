import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { parseLabels } from './labels.js';
import {
  COOLDOWN_MS,
  LABEL_AUTO_SHIP,
  LABEL_CAPABILITY_BLOCKED,
  LABEL_FAILED,
  LABEL_IFLEET_CHRONIC_FAIL,
  LABEL_IFLEET_COOLDOWN,
  LABEL_IFLEET_DONE,
  LABEL_IFLEET_IN_PROGRESS,
  LABEL_IN_FLIGHT,
  LABEL_RETRY_PREFIX,
  LABEL_SHIPPED,
  MAX_AUTO_RETRIES,
  type PickOpts,
  type QueueAdapter,
  type QueuedTask,
  type RepoRef,
  type TaskStatus,
} from '@wahq/orchestrator-core/queue/types';

const execFileAsync = promisify(execFile);

const ThrottledOctokit = Octokit.plugin(throttling);

/** Maximum number of times Octokit will retry a request that hit a rate limit. */
export const THROTTLE_MAX_RETRIES = 2;

interface ThrottleRequestOptions {
  method?: string;
  url?: string;
  request?: { retryCount?: number };
}

/**
 * Decide whether Octokit should retry a (primary or secondary) rate-limited
 * request. Pure function exported so the wiring can be unit-tested.
 *
 * Returns `true` to retry, `false` to abort. Logs to the provided `logger`
 * (defaults to `console.warn`) so tests can capture without polluting stdout.
 */
export function shouldRetryRateLimit(
  retryAfter: number,
  options: ThrottleRequestOptions,
  kind: 'primary' | 'secondary',
  logger: (msg: string) => void = console.warn,
): boolean {
  const retryCount = options.request?.retryCount ?? 0;
  const where = `${options.method ?? '?'} ${options.url ?? '?'}`;
  const tag = kind === 'secondary' ? 'secondary rate limit' : 'rate limit hit';
  logger(`[queue] ${tag} on ${where}; retry in ${retryAfter}s (attempt ${retryCount + 1})`);
  return retryCount < THROTTLE_MAX_RETRIES;
}

/**
 * True when the operator has DELIBERATELY opted into accepting `auto:ship`
 * issues from any author via `IFLEET_ALLOW_ALL_AUTHORS=1` (or `=true`). This is
 * the only escape hatch out of the fail-closed default below and must never be
 * set on a public repo — the worker spawns `claude -p --permission-mode auto`
 * on the issue body, so allow-all means any GitHub user can drive the runner.
 *
 * `env` is injectable so the wiring can be unit-tested without mutating the
 * real process environment.
 */
export function allowAllAuthorsOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.IFLEET_ALLOW_ALL_AUTHORS;
  return v === '1' || v === 'true';
}

/**
 * Decide whether `author` may open `auto:ship` issues for `repo`. Pure
 * function exported so the wiring can be unit-tested.
 *
 * Returns `true` when the author is in `repo.allowedAuthors`.
 *
 * FAIL-CLOSED: when the repo has no allowlist (undefined or empty array) the
 * function returns `false` (deny) — an unconfigured author gate on a PUBLIC,
 * branch-protected repo must not fall open, because the worker runs
 * `claude -p --permission-mode auto` on the issue body. The only way to restore
 * allow-all is the deliberate `IFLEET_ALLOW_ALL_AUTHORS=1` opt-in, surfaced via
 * the `allowAll` argument (defaults to {@link allowAllAuthorsOptIn}). The queue
 * also announces an unconfigured allowlist with a loud warning at construction.
 */
export function isAuthorAllowed(
  repo: RepoRef,
  author: string,
  allowAll: boolean = allowAllAuthorsOptIn(),
): boolean {
  if (!repo.allowedAuthors || repo.allowedAuthors.length === 0) return allowAll;
  return repo.allowedAuthors.includes(author);
}

export interface GitHubQueueOptions {
  repos: RepoRef[];
  token?: string;
  pollIntervalMs?: number;
  octokit?: Octokit;
  /** Override timestamp source (useful for tests). */
  now?: () => number;
}

export async function createGitHubQueue(opts: GitHubQueueOptions): Promise<GitHubQueue> {
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? (await readGhAuthToken());
  if (!token && !opts.octokit) {
    throw new Error('No GitHub token available. Set GITHUB_TOKEN or login via `gh auth login`.');
  }
  const octokit =
    opts.octokit ??
    new ThrottledOctokit({
      auth: token,
      throttle: {
        onRateLimit: (retryAfter, options) =>
          shouldRetryRateLimit(retryAfter, options as ThrottleRequestOptions, 'primary'),
        onSecondaryRateLimit: (retryAfter, options) =>
          shouldRetryRateLimit(retryAfter, options as ThrottleRequestOptions, 'secondary'),
      },
    });
  return new GitHubQueue(octokit, opts);
}

async function readGhAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export class GitHubQueue implements QueueAdapter {
  private readonly octokit: Octokit;
  private readonly repos: RepoRef[];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(octokit: Octokit, opts: GitHubQueueOptions) {
    this.octokit = octokit;
    this.repos = opts.repos;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    const allowAll = allowAllAuthorsOptIn();
    for (const repo of this.repos) {
      if (repo.allowedAuthors && repo.allowedAuthors.length > 0) continue;
      if (allowAll) {
        console.warn(
          `[queue] WARNING: ${repo.owner}/${repo.name} has no allowedAuthors but ` +
            `IFLEET_ALLOW_ALL_AUTHORS is set — accepting "auto:ship" issues from ANY author. ` +
            `This is INSECURE for public repos because the worker spawns ` +
            `"claude -p --permission-mode auto" on the issue body. Configure ` +
            `"allowedAuthors": ["<github-login>", ...] in config/repos.json and unset the override.`,
        );
      } else {
        console.warn(
          `[queue] ${repo.owner}/${repo.name} has no allowedAuthors configured — ` +
            `DENYING all "auto:ship" issues (fail-closed). Set ` +
            `"allowedAuthors": ["<github-login>", ...] in config/repos.json, or set ` +
            `IFLEET_ALLOW_ALL_AUTHORS=1 to deliberately accept every author (INSECURE for public repos).`,
        );
      }
    }
  }

  async pickNext(opts: PickOpts = {}): Promise<QueuedTask | null> {
    const targets = this.filterRepos(opts.repos);
    const exclude = new Set(opts.excludeIds ?? []);
    const candidates: QueuedTask[] = [];

    for (const repo of targets) {
      const issues = await this.listOpenAutoShip(repo);
      for (const task of issues) {
        if (exclude.has(task.id)) continue;
        if (task.labels.includes(LABEL_IN_FLIGHT)) continue;
        // `auto:failed` is a terminal state: IFleet attempted but failed,
        // human review required. Without this guard, every 5-min cron tick
        // re-picks the same failing issue forever (crash loop).
        if (task.labels.includes(LABEL_FAILED)) continue;
        if (!isAuthorAllowed(repo, task.author)) {
          console.warn(
            `[queue] skipping ${task.repo}#${task.issueNumber}: author "${task.author}" not in allowedAuthors`,
          );
          continue;
        }
        candidates.push(task);
      }
    }

    candidates.sort((a, b) => {
      const pa = priorityRank(a.routingHints.priority);
      const pb = priorityRank(b.routingHints.priority);
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });

    return candidates[0] ?? null;
  }

  async markPicked(task: QueuedTask, workerId: string): Promise<void> {
    // Remove `auto:ship` first so a crash or hung pipeline can't re-queue the
    // same issue on the next cron tick (the bug that burned tokens on
    // #70/#72/#75). `ifleet:in_progress` is the new state marker; `in_flight`
    // is kept for the legacy pickNext guard.
    await this.removeLabel(task, LABEL_AUTO_SHIP);
    await this.addLabels(task, [LABEL_IN_FLIGHT, LABEL_IFLEET_IN_PROGRESS]);
    const stamp = new Date(this.now()).toISOString();
    await this.comment(task, `🤖 Picked up by \`${workerId}\` at \`${stamp}\``);
  }

  async markCompleted(task: QueuedTask, prUrl: string): Promise<void> {
    await this.removeLabel(task, LABEL_IN_FLIGHT);
    await this.removeLabel(task, LABEL_IFLEET_IN_PROGRESS);
    await this.addLabels(task, [LABEL_SHIPPED, LABEL_IFLEET_DONE]);
    await this.comment(task, `✅ Completed — PR: ${prUrl}`);
  }

  async markFailed(task: QueuedTask, reason: string): Promise<void> {
    await this.removeLabel(task, LABEL_IN_FLIGHT);
    await this.removeLabel(task, LABEL_IFLEET_IN_PROGRESS);
    // Bump the retry counter via a label of the form `ifleet:retry:N`. After
    // MAX_AUTO_RETRIES failures the issue gets `ifleet:chronic-fail` and
    // sweepCooldowns will skip it — a human must remove the label to
    // re-enable retries. This is the backstop against the infinite-loop
    // token burn that #70/#72/#75 hit.
    //
    // Read CURRENT labels from GitHub (not task.labels, which is the
    // snapshot from pickNext and can be minutes stale). A concurrent
    // sweepCooldowns or operator hand-edit between pickNext and
    // markFailed can otherwise cause the retry counter to regress.
    const freshLabels = await this.fetchIssueLabels(task);
    const currentRetry = this.readRetryCount(freshLabels);
    const nextRetry = currentRetry + 1;
    const newLabels: string[] = [LABEL_FAILED, LABEL_IFLEET_COOLDOWN, `${LABEL_RETRY_PREFIX}${nextRetry}`];
    if (nextRetry >= MAX_AUTO_RETRIES) {
      newLabels.push(LABEL_IFLEET_CHRONIC_FAIL);
    }
    // Replace the prior retry label to keep the issue tidy.
    if (currentRetry > 0) {
      await this.removeLabel(task, `${LABEL_RETRY_PREFIX}${currentRetry}`);
    }
    await this.addLabels(task, newLabels);
    const tail =
      nextRetry >= MAX_AUTO_RETRIES
        ? ` Marked \`${LABEL_IFLEET_CHRONIC_FAIL}\` after ${nextRetry} failure(s); auto-retry disabled.`
        : ` (cooldown ${COOLDOWN_MS / 60_000}m before retry ${nextRetry}/${MAX_AUTO_RETRIES})`;
    await this.comment(task, `❌ Failed: ${reason}${tail}`);
  }

  /**
   * Restore issues whose `ifleet:cooldown` was set more than COOLDOWN_MS ago.
   * Skips any issue with `ifleet:chronic-fail` (retry cap hit).
   *
   * Ordering matters for crash-safety (AUDIT-IFleet-80abf649): we remove
   * `auto:failed` first, then add `auto:ship`, then remove `ifleet:cooldown`.
   * If the process dies after steps 1-2 the issue is pickable with a stale
   * cooldown label that the NEXT sweep will clean up. If it dies after only
   * step 1 the issue is no worse off than a manual triage.
   */
  async sweepCooldowns(): Promise<{ restored: number; remaining: number; skippedChronic: number }> {
    let restored = 0;
    let remaining = 0;
    let skippedChronic = 0;
    for (const repo of this.repos) {
      const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
        owner: repo.owner,
        repo: repo.name,
        state: 'open',
        labels: LABEL_IFLEET_COOLDOWN,
        per_page: 100,
      });
      for (const issue of issues) {
        const labelNames = (issue.labels as ReadonlyArray<string | { name?: string | null }>)
          .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
          .filter((n) => n.length > 0);
        if (!labelNames.includes(LABEL_IFLEET_COOLDOWN)) continue;
        if (labelNames.includes(LABEL_IFLEET_CHRONIC_FAIL)) {
          skippedChronic++;
          continue;
        }
        const labelAddedAt = await this.findLabelAddedAt(repo, issue.number, LABEL_IFLEET_COOLDOWN);
        if (labelAddedAt === null) continue;
        const elapsed = this.now() - labelAddedAt;
        if (elapsed < COOLDOWN_MS) {
          remaining++;
          continue;
        }
        try {
          // Step 1: drop `auto:failed` so pickNext won't skip it.
          await this.octokit.issues.removeLabel({
            owner: repo.owner,
            repo: repo.name,
            issue_number: issue.number,
            name: LABEL_FAILED,
          }).catch((err) => { if (!isNotFound(err)) throw err; });
          // Step 2: add `auto:ship` so pickNext sees it next tick.
          await this.octokit.issues.addLabels({
            owner: repo.owner,
            repo: repo.name,
            issue_number: issue.number,
            labels: [LABEL_AUTO_SHIP],
          });
          // Step 3: remove `ifleet:cooldown` last — if we crash here, the
          // next sweep will see the stale cooldown + auto:ship, find the
          // cooldown is past COOLDOWN_MS, and idempotently re-clean it.
          await this.octokit.issues.removeLabel({
            owner: repo.owner,
            repo: repo.name,
            issue_number: issue.number,
            name: LABEL_IFLEET_COOLDOWN,
          }).catch((err) => { if (!isNotFound(err)) throw err; });
          // Step 4: strip stale `ifleet:retry:N` labels — they only document
          // the prior attempt count and a successful restore should reset
          // the counter narrative. markFailed re-reads labels live so this
          // is purely a tidiness step (b06f33f2).
          for (const label of labelNames) {
            if (!label.startsWith(LABEL_RETRY_PREFIX)) continue;
            await this.octokit.issues.removeLabel({
              owner: repo.owner,
              repo: repo.name,
              issue_number: issue.number,
              name: label,
            }).catch((err) => { if (!isNotFound(err)) throw err; });
          }
          restored++;
        } catch (err) {
          console.warn(
            `[queue] sweepCooldowns: failed to restore ${repo.owner}/${repo.name}#${issue.number}:`,
            err,
          );
        }
      }
    }
    return { restored, remaining, skippedChronic };
  }

  /** Read the live label list from GitHub for the issue behind a task. */
  private async fetchIssueLabels(task: QueuedTask): Promise<ReadonlyArray<string>> {
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) return task.labels;
    try {
      const res = await this.octokit.issues.listLabelsOnIssue({
        owner,
        repo: name,
        issue_number: task.issueNumber,
      });
      return res.data
        .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
        .filter((s) => s.length > 0);
    } catch (err) {
      console.warn(
        `[queue] fetchIssueLabels ${task.repo}#${task.issueNumber} failed, ` +
          `falling back to task.labels snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
      return task.labels;
    }
  }

  /**
   * Read the current retry count from labels of the form `ifleet:retry:N`.
   * Returns 0 when no such label is present. If multiple are present (corrupted
   * state) the highest N wins so we never under-count.
   */
  private readRetryCount(labels: ReadonlyArray<string>): number {
    let max = 0;
    for (const label of labels) {
      if (!label.startsWith(LABEL_RETRY_PREFIX)) continue;
      const n = Number.parseInt(label.slice(LABEL_RETRY_PREFIX.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  private async findLabelAddedAt(
    repo: RepoRef,
    issueNumber: number,
    label: string,
  ): Promise<number | null> {
    const events = await this.octokit.paginate(this.octokit.issues.listEvents, {
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      per_page: 100,
    });
    let latest = 0;
    for (const ev of events) {
      const labelName = (ev as { label?: { name?: string } }).label?.name;
      if (ev.event === 'labeled' && labelName === label) {
        const ts = Date.parse(ev.created_at);
        if (Number.isFinite(ts) && ts > latest) latest = ts;
      }
    }
    return latest > 0 ? latest : null;
  }

  async markCapabilityBlocked(task: QueuedTask, missing: string[]): Promise<void> {
    await this.removeLabel(task, LABEL_IN_FLIGHT);
    await this.addLabels(task, [LABEL_CAPABILITY_BLOCKED]);
    const list = missing.map((m) => `\`${m}\``).join(', ');
    await this.comment(
      task,
      `🚫 Cannot run: missing capabilities: ${list}. Not provisioned on this runner.`,
    );
  }

  async postStatus(task: QueuedTask, status: TaskStatus, message?: string): Promise<void> {
    const body = renderStatus(status, message);
    const existing = await this.findStatusComment(task);
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) throw new Error(`invalid repo on task: ${task.repo}`);
    if (existing) {
      await this.octokit.issues.updateComment({ owner, repo: name, comment_id: existing, body });
    } else {
      await this.comment(task, body);
    }
  }

  watchForNew(callback: (task: QueuedTask) => void): { stop: () => void } {
    const seen = new Set<string>();
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        for (const repo of this.repos) {
          const issues = await this.listOpenAutoShip(repo);
          for (const task of issues) {
            if (task.labels.includes(LABEL_IN_FLIGHT)) continue;
            if (seen.has(task.id)) continue;
            if (!isAuthorAllowed(repo, task.author)) {
              seen.add(task.id);
              console.warn(
                `[queue] watch: skipping ${task.repo}#${task.issueNumber}: author "${task.author}" not in allowedAuthors`,
              );
              continue;
            }
            seen.add(task.id);
            callback(task);
          }
        }
      } catch (err) {
        console.warn('[queue] watch tick failed:', err);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => void tick(), this.pollIntervalMs);
        }
      }
    };

    void tick();

    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  private filterRepos(filter?: string[]): RepoRef[] {
    if (!filter || filter.length === 0) return this.repos;
    const allow = new Set(filter);
    return this.repos.filter((r) => allow.has(`${r.owner}/${r.name}`));
  }

  private async listOpenAutoShip(repo: RepoRef): Promise<QueuedTask[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      labels: LABEL_AUTO_SHIP,
      per_page: 100,
    });
    const tasks: QueuedTask[] = [];
    for (const issue of issues) {
      if ('pull_request' in issue && issue.pull_request) continue;
      tasks.push(toTask(repo, issue));
    }
    return tasks;
  }

  private async addLabels(task: QueuedTask, labels: string[]): Promise<void> {
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) throw new Error(`invalid repo on task: ${task.repo}`);
    await this.octokit.issues.addLabels({
      owner,
      repo: name,
      issue_number: task.issueNumber,
      labels,
    });
  }

  private async removeLabel(task: QueuedTask, label: string): Promise<void> {
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) throw new Error(`invalid repo on task: ${task.repo}`);
    try {
      await this.octokit.issues.removeLabel({
        owner,
        repo: name,
        issue_number: task.issueNumber,
        name: label,
      });
    } catch (err: unknown) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async comment(task: QueuedTask, body: string): Promise<void> {
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) throw new Error(`invalid repo on task: ${task.repo}`);
    await this.octokit.issues.createComment({
      owner,
      repo: name,
      issue_number: task.issueNumber,
      body,
    });
  }

  private async findStatusComment(task: QueuedTask): Promise<number | null> {
    const [owner, name] = task.repo.split('/');
    if (!owner || !name) throw new Error(`invalid repo on task: ${task.repo}`);
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner,
      repo: name,
      issue_number: task.issueNumber,
      per_page: 100,
    });
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (c && typeof c.body === 'string' && c.body.startsWith(STATUS_MARKER)) {
        return c.id;
      }
    }
    return null;
  }
}

const STATUS_MARKER = '<!-- ifleet:status -->';

function renderStatus(status: TaskStatus, message?: string): string {
  const tail = message ? `\n\n${message}` : '';
  return `${STATUS_MARKER}\n**Status:** \`${status}\`${tail}`;
}

function priorityRank(p: 'low' | 'normal' | 'high'): number {
  if (p === 'high') return 0;
  if (p === 'normal') return 1;
  return 2;
}

interface IssueLike {
  number: number;
  title: string;
  body?: string | null;
  labels: ReadonlyArray<string | { name?: string | null }>;
  created_at: string;
  html_url: string;
  node_id: string;
  user?: { login?: string | null } | null;
}

function toTask(repo: RepoRef, issue: IssueLike): QueuedTask {
  const labels = issue.labels
    .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
    .filter((s): s is string => s.length > 0);
  const parsedAt = Date.parse(issue.created_at);
  const createdAt = Number.isFinite(parsedAt) ? parsedAt : Date.now();
  return {
    id: issue.node_id,
    repo: `${repo.owner}/${repo.name}`,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    author: issue.user?.login ?? '',
    labels,
    routingHints: parseLabels(labels),
    createdAt,
    url: issue.html_url,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: number }).status === 404;
}
