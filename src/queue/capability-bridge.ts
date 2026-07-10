import type { OrchestratorEvent } from '../orchestrator/types.js';
import type { QueueAdapter, QueuedTask } from '@wahq/orchestrator-core/queue/types';

export interface EventSource {
  on(event: string, cb: (event: OrchestratorEvent) => void): unknown;
}

export class CapabilityBridge {
  private readonly taskMap = new Map<string, QueuedTask>();
  private readonly queue: QueueAdapter;

  constructor(source: EventSource, queue: QueueAdapter) {
    this.queue = queue;
    source.on('task.capability_blocked', (event) => {
      this.handleBlocked(event).catch((err) => {
        console.error('[capability-bridge] handleBlocked failed:', err);
      });
    });
    source.on('task.completed', (event) => { if (event.taskId) this.taskMap.delete(event.taskId); });
    source.on('task.failed', (event) => { if (event.taskId) this.taskMap.delete(event.taskId); });
  }

  register(taskId: string, task: QueuedTask): void {
    this.taskMap.set(taskId, task);
  }

  unregister(taskId: string): void {
    this.taskMap.delete(taskId);
  }

  private async handleBlocked(event: OrchestratorEvent): Promise<void> {
    if (!event.taskId) return;
    const task = this.taskMap.get(event.taskId);
    if (!task) return;
    this.taskMap.delete(event.taskId);
    const missing = event.payload.missing;
    if (!Array.isArray(missing) || !missing.every((item) => typeof item === 'string')) {
      console.warn('[capability-bridge] ignoring capability_blocked event with invalid missing payload');
      return;
    }
    await this.queue.markCapabilityBlocked(task, missing);
  }
}
