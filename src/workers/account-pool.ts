import type { WorkerConfig } from '../orchestrator/types.ts';

export interface AccountPool {
  /**
   * Round-robin selector. Skips workers currently paused due to rate limits
   * or auth failures. Throws `AllAccountsPausedError` when every enabled
   * worker is paused, and `AccountPoolEmptyError` when none are enabled.
   */
  nextWorker(): WorkerConfig;
  /**
   * Side-effect-free pick. Returns a discriminated result so callers can
   * react to "all paused" by sleeping until `nextAvailableMs` instead of
   * spin-looping.
   */
  acquire(): AcquireResult;
  /** Number of enabled Claude workers in the pool (paused workers still count). */
  workerCount(): number;
  /** Pause a worker for at least `retryAfterMs` because of a rate-limit event. */
  markRateLimited(id: string, retryAfterMs: number): void;
  /** Permanently disable a worker for the lifetime of this pool (auth failure). */
  markAuthFailed(id: string): void;
  /** Snapshot pause state (test/debug). */
  pausedUntil(id: string): number | null;
}

export type AcquireResult =
  | { kind: 'ok'; worker: WorkerConfig }
  | { kind: 'all_paused'; nextAvailableMs: number }
  | { kind: 'empty' };

export class AccountPoolEmptyError extends Error {
  override readonly name = 'AccountPoolEmptyError';
  constructor() {
    super('AccountPool: no enabled claude workers available');
  }
}

export class AllAccountsPausedError extends Error {
  override readonly name = 'AllAccountsPausedError';
  readonly nextAvailableMs: number;
  constructor(nextAvailableMs: number) {
    super(`AccountPool: all enabled workers paused; next available in ${nextAvailableMs}ms`);
    this.nextAvailableMs = nextAvailableMs;
  }
}

export interface AccountPoolOptions {
  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
}

/**
 * Build a round-robin selector across enabled Claude workers. Disabled workers
 * and non-claude providers are skipped at construction. Workers paused for a
 * rate-limit are skipped until the pause expires; workers flagged as
 * auth-failed are skipped for the lifetime of this pool.
 *
 * The pool is intentionally stateless about concurrency — callers that need
 * acquire/release semantics should layer that on top.
 */
export function createAccountPool(
  workers: ReadonlyArray<WorkerConfig>,
  options: AccountPoolOptions = {},
): AccountPool {
  const eligible = workers.filter((w) => w.provider === 'claude' && w.enabled);
  const now = options.now ?? Date.now;
  // pausedUntil = ms-since-epoch the pause expires. Number.POSITIVE_INFINITY
  // for permanent disables (auth failures).
  const pausedUntil = new Map<string, number>();
  let cursor = 0;

  const isPaused = (id: string): boolean => {
    const until = pausedUntil.get(id);
    if (until === undefined) return false;
    if (until === Number.POSITIVE_INFINITY) return true;
    if (until <= now()) {
      pausedUntil.delete(id);
      return false;
    }
    return true;
  };

  const findAvailable = (): WorkerConfig | null => {
    const len = eligible.length;
    if (len === 0) return null;
    for (let i = 0; i < len; i++) {
      const idx = (cursor + i) % len;
      const candidate = eligible[idx] as WorkerConfig;
      if (!isPaused(candidate.id)) {
        cursor = (idx + 1) % len;
        return candidate;
      }
    }
    return null;
  };

  const soonestRecoveryMs = (): number => {
    let soonest = Number.POSITIVE_INFINITY;
    const t = now();
    for (const candidate of eligible) {
      const until = pausedUntil.get(candidate.id);
      if (until === undefined) continue;
      if (until === Number.POSITIVE_INFINITY) continue;
      const wait = Math.max(0, until - t);
      if (wait < soonest) soonest = wait;
    }
    return soonest === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : soonest;
  };

  return {
    nextWorker(): WorkerConfig {
      if (eligible.length === 0) throw new AccountPoolEmptyError();
      const picked = findAvailable();
      if (picked === null) throw new AllAccountsPausedError(soonestRecoveryMs());
      return picked;
    },
    acquire(): AcquireResult {
      if (eligible.length === 0) return { kind: 'empty' };
      const picked = findAvailable();
      if (picked === null) return { kind: 'all_paused', nextAvailableMs: soonestRecoveryMs() };
      return { kind: 'ok', worker: picked };
    },
    workerCount(): number {
      return eligible.length;
    },
    markRateLimited(id: string, retryAfterMs: number): void {
      if (retryAfterMs <= 0) {
        // Never clear a permanent auth-failed ban (Infinity).
        if (pausedUntil.get(id) === Number.POSITIVE_INFINITY) return;
        pausedUntil.delete(id);
        return;
      }
      const existing = pausedUntil.get(id) ?? 0;
      const until = now() + retryAfterMs;
      // Keep the longer pause if we already have one (e.g. auth-failed = infinity).
      if (until > existing) pausedUntil.set(id, until);
    },
    markAuthFailed(id: string): void {
      pausedUntil.set(id, Number.POSITIVE_INFINITY);
    },
    pausedUntil(id: string): number | null {
      return pausedUntil.get(id) ?? null;
    },
  };
}
