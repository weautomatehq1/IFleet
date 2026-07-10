import type { QueuedTask } from '../../contracts/task.js';
import type { TaskStore } from '../store.js';

export interface TaskSource {
  readonly kind: 'github' | 'discord';
  /** Pull new pending tasks into the store. Returns the count actually inserted. */
  drain(store: TaskStore): Promise<number>;
  markPicked(task: QueuedTask): Promise<void>;
  markCompleted(task: QueuedTask, prUrl: string, totalTokens?: number): Promise<void>;
  markFailed(task: QueuedTask, reason: string): Promise<void>;
  markBlocked(task: QueuedTask, capability: string): Promise<void>;
}
