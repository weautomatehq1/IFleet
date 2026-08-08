import { createHash } from 'node:crypto';
import type { QueuedTask, TaskSource as TaskSourceType } from '@wahq/orchestrator-core/contracts/task';
import { ulid } from '@wahq/orchestrator-core/utils/ulid';
import type { GitHubQueue } from '../github.js';
import type { QueuedTask as LegacyGitHubTask } from '@wahq/orchestrator-core/queue/types';
import type { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { TaskSource } from '@wahq/orchestrator-core/queue/sources/base';

/**
 * Wraps the existing GitHubQueue so issues land in the unified TaskStore.
 * The legacy adapter still owns all Octokit calls (label/comment mutations).
 */
export class GitHubIssuesSource implements TaskSource {
  readonly kind = 'github' as const;

  constructor(private readonly queue: GitHubQueue) {}

  async drain(store: TaskStore): Promise<number> {
    // Fetch all open candidates in one pass (one API call per repo) rather than
    // calling pickNext in a loop, which made O(N) GitHub API calls per drain
    // cycle and exhausted the rate limit on non-trivial queues (AUDIT-IFleet-<new>).
    const candidates = await this.queue.listAllCandidates();
    let inserted = 0;
    for (const next of candidates) {
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

  async markCancelled(task: QueuedTask, reason: string): Promise<void> {
    await this.queue.markFailed(unifiedToLegacyShape(task), `Cancelled: ${reason}`);
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
