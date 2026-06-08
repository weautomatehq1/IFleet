// Unified queue adapter — wraps {@link TaskStore} and routes lifecycle events
// back to the correct {@link TaskSource} (GitHub issues vs. Discord threads).
//
// This is the integration seam between the new unified `QueuedTask` model and
// the production daemon's pick/dispatch loop. The orchestrator polls
// `pickNext()` for work; lifecycle methods flip store state AND notify the
// originating source so the user sees the right side-effect (GitHub label
// flip or Discord thread message).

import type { DiscordOut } from '../contracts/discord-out.js';
import type { QueuedTask } from '../contracts/task.js';
import type { TaskSource } from './sources/base.js';
import type { PickFilter, TaskStore } from './store.js';

export interface UnifiedAdapterSources {
  github: TaskSource;
  discord: TaskSource;
}

export class UnifiedQueueAdapter {
  constructor(
    private readonly store: TaskStore,
    private readonly sources: UnifiedAdapterSources,
    /**
     * Optional pass-through for `postStatus`. When omitted, status updates for
     * Discord-sourced tasks are silently dropped — the daemon supplies this
     * the same `DiscordOut` instance it constructs for `DiscordSource`.
     */
    private readonly discordOut?: DiscordOut,
  ) {}

  /**
   * Pops the next pending task. `store.pickNext()` atomically claims it inside
   * BEGIN IMMEDIATE, so two daemons sharing the SQLite file cannot both pick
   * the same row. `markPicked` runs after the claim; a side-effect failure
   * (e.g. GitHub API hiccup) leaves the row in_flight and recoverable via
   * recoverStale(), not re-picked as pending (AUDIT-IFleet-de355093).
   */
  async pickNext(filter?: PickFilter): Promise<QueuedTask | null> {
    const task = this.store.pickNext(filter);
    if (!task) return null;
    try {
      await this.sourceFor(task).markPicked(task);
    } catch (err) {
      console.warn(
        `[unified-queue] markPicked failed for ${task.id} (${task.source.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return task;
  }

  async markCompleted(task: QueuedTask, prUrl: string, totalTokens?: number): Promise<void> {
    this.store.updateState(task.id, 'done', { prUrl, completedAt: Date.now() });
    try {
      await this.sourceFor(task).markCompleted(task, prUrl, totalTokens);
    } catch (err) {
      console.warn(
        `[unified-queue] markCompleted notification failed for ${task.id} (${task.source.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async markFailed(task: QueuedTask, reason: string): Promise<void> {
    this.store.updateState(task.id, 'failed', { reason, completedAt: Date.now() });
    try {
      await this.sourceFor(task).markFailed(task, reason);
    } catch (err) {
      console.warn(
        `[unified-queue] markFailed notification failed for ${task.id} (${task.source.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async markBlocked(task: QueuedTask, capability: string): Promise<void> {
    this.store.updateState(task.id, 'blocked', { capability });
    try {
      await this.sourceFor(task).markBlocked(task, capability);
    } catch (err) {
      console.warn(
        `[unified-queue] markBlocked notification failed for ${task.id} (${task.source.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Best-effort progress note — GitHub has no native "status" comment, so
   * this currently only flows for Discord-sourced tasks. GitHub-sourced
   * status comments live on the legacy `GitHubQueue.postStatus` path which
   * the daemon may invoke separately when needed.
   */
  async postStatus(task: QueuedTask, message: string): Promise<void> {
    if (task.source.kind === 'discord' && this.discordOut) {
      const threadId = task.source.threadId;
      if (threadId) await this.discordOut.postProgress(threadId, message);
    }
  }

  private sourceFor(task: QueuedTask): TaskSource {
    switch (task.source.kind) {
      case 'github':
        return this.sources.github;
      case 'discord':
        return this.sources.discord;
      default: {
        const _exhaustive: never = task.source;
        throw new Error(`[unified-queue] unknown task source kind: ${(_exhaustive as { kind: string }).kind}`);
      }
    }
  }
}
