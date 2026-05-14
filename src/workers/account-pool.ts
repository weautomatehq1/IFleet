import type { WorkerConfig } from '../orchestrator/types.ts';

export interface AccountPool {
  /** Returns the next available Claude worker config, cycling round-robin. */
  nextWorker(): WorkerConfig;
  /** Number of enabled Claude workers in the pool. */
  workerCount(): number;
}

export class AccountPoolEmptyError extends Error {
  override readonly name = 'AccountPoolEmptyError';
  constructor() {
    super('AccountPool: no enabled claude workers available');
  }
}

/**
 * Build a round-robin selector across enabled Claude workers. Disabled workers and
 * non-claude providers are skipped. The cursor advances on every call; callers that
 * need atomic acquire/release semantics should layer that on top.
 */
export function createAccountPool(workers: ReadonlyArray<WorkerConfig>): AccountPool {
  const eligible = workers.filter((w) => w.provider === 'claude' && w.enabled);
  let cursor = 0;
  return {
    nextWorker(): WorkerConfig {
      if (eligible.length === 0) throw new AccountPoolEmptyError();
      const next = eligible[cursor % eligible.length] as WorkerConfig;
      cursor++;
      return next;
    },
    workerCount(): number {
      return eligible.length;
    },
  };
}
