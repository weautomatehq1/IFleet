import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { parseLabels } from './labels.js';
import {
  LABEL_AUTO_SHIP,
  LABEL_CAPABILITY_BLOCKED,
  LABEL_FAILED,
  LABEL_IN_FLIGHT,
  LABEL_SHIPPED,
  type PickOpts,
  type QueueAdapter,
  type QueuedTask,
  type RepoRef,
  type TaskStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

const ThrottledOctokit = Octokit.plugin(throttling);

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
        onRateLimit: (retryAfter, options) => {
          const o = options as { method?: string; url?: string; request?: { retryCount?: number } };
          console.warn(`[queue] rate limit hit on ${o.method} ${o.url}; retry in ${retryAfter}s`);
          return (o.request?.retryCount ?? 0) < 2;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          const o = options as { method?: string; url?: string; request?: { retryCount?: number } };
          console.warn(`[queue] secondary rate limit on ${o.method} ${o.url}; retry in ${retryAfter}s`);
          return (o.request?.retryCount ?? 0) < 2;
        },
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
    await this.addLabels(task, [LABEL_IN_FLIGHT]);
    const stamp = new Date(this.now()).toISOString();
    await this.comment(task, `🤖 Picked up by \`${workerId}\` at \`${stamp}\``);
  }

  async markCompleted(task: QueuedTask, prUrl: string): Promise<void> {
    await this.removeLabel(task, LABEL_IN_FLIGHT);
    await this.addLabels(task, [LABEL_SHIPPED]);
    await this.comment(task, `✅ Completed — PR: ${prUrl}`);
  }

  async markFailed(task: QueuedTask, reason: string): Promise<void> {
    await this.removeLabel(task, LABEL_IN_FLIGHT);
    await this.addLabels(task, [LABEL_FAILED]);
    await this.comment(task, `❌ Failed: ${reason}`);
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
}

function toTask(repo: RepoRef, issue: IssueLike): QueuedTask {
  const labels = issue.labels
    .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
    .filter((s): s is string => s.length > 0);
  return {
    id: issue.node_id,
    repo: `${repo.owner}/${repo.name}`,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    labels,
    routingHints: parseLabels(labels),
    createdAt: Date.parse(issue.created_at),
    url: issue.html_url,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: number }).status === 404;
}
