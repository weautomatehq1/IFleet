import { createHash } from 'node:crypto';
import type { QueuedTask, TaskSource as TaskSourceType } from '../../contracts/task.js';
import { ulid } from '../../utils/ulid.js';
import type { GitHubQueue } from '../github.js';
import type { QueuedTask as LegacyGitHubTask } from '../types.js';
import type { TaskStore } from '../store.js';
import type { TaskSource } from './base.js';

/**
 * Wraps the existing GitHubQueue so issues land in the unified TaskStore.
 * The legacy adapter still owns all Octokit calls (label/comment mutations).
 */
export class GitHubIssuesSource implements TaskSource {
  readonly kind = 'github' as const;

  constructor(private readonly queue: GitHubQueue) {}

  async drain(store: TaskStore): Promise<number> {
    let inserted = 0;
    // GitHubQueue#pickNext returns the top candidate; we want *all* open
    // candidates, but listOpenAutoShip is private. We reach in via the public
    // pickNext + excludeIds loop until exhausted. Cheap because pickNext only
    // does N issues worth of work and the unified store already de-dupes.
    const exclude = new Set<string>();
    const MAX_DRAIN = 200;
    let drainCount = 0;
    for (;;) {
      if (drainCount++ >= MAX_DRAIN) break;
      const next = await this.queue.pickNext({ excludeIds: Array.from(exclude) });
      if (!next) break;
      if (exclude.has(next.id)) break;
      exclude.add(next.id);
      const unified = legacyToUnified(next);
      const res = store.insert(unified);
      if (res.inserted) inserted++;
    }
    return inserted;
  }

  async markPicked(task: QueuedTask): Promise<void> {
    const legacy = unifiedToLegacyShape(task);
    await this.queue.markPicked(legacy, 'unified-store');
  }

  async markCompleted(task: QueuedTask, prUrl: string, _totalTokens?: number): Promise<void> {
    await this.queue.markCompleted(unifiedToLegacyShape(task), prUrl);
  }

  async markFailed(task: QueuedTask, reason: string): Promise<void> {
    await this.queue.markFailed(unifiedToLegacyShape(task), reason);
  }

  async markBlocked(task: QueuedTask, capability: string): Promise<void> {
    await this.queue.markCapabilityBlocked(unifiedToLegacyShape(task), [capability]);
  }
}

export function legacyToUnified(legacy: LegacyGitHubTask): QueuedTask {
  const source: TaskSourceType = {
    kind: 'github',
    repo: legacy.repo,
    issueNumber: legacy.issueNumber,
    issueNodeId: legacy.id,
    url: legacy.url,
  };
  const idempotencyKey = idempotencyForGitHub(legacy.id);
  return {
    id: ulid(legacy.createdAt),
    source,
    repo: legacy.repo,
    brief: legacy.body,
    title: legacy.title,
    routingHints: legacy.routingHints,
    createdAt: legacy.createdAt,
    idempotencyKey,
    state: 'pending',
  };
}

export function idempotencyForGitHub(issueNodeId: string): string {
  return createHash('sha256').update(`github:${issueNodeId}`).digest('hex');
}

/**
 * Reconstruct a legacy-shaped task for the existing GitHubQueue mutators. We
 * only need the fields they actually touch (`repo`, `issueNumber`, `labels`).
 */
function unifiedToLegacyShape(task: QueuedTask): LegacyGitHubTask {
  if (task.source.kind !== 'github') {
    throw new Error(`GitHubIssuesSource cannot mark a ${task.source.kind} task`);
  }
  return {
    id: task.source.issueNodeId,
    repo: task.source.repo,
    issueNumber: task.source.issueNumber,
    title: task.title,
    body: task.brief,
    author: '',
    labels: [],
    routingHints: task.routingHints,
    createdAt: task.createdAt,
    url: task.source.url,
  };
}
