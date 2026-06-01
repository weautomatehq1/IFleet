// Cross-process lock for `.audits/closed.json` writes.
//
// Why this exists: `appendToClosedJson` and the closed.json branch of
// `markFindingsClosed` do read-modify-write. With multiple processes touching
// the same repo's closed.json (e.g. the standalone `/audit-fix` skill running
// alongside the IFleet pipeline runner closing a different finding), two
// writers can interleave their read+append+rename and silently drop one of
// the records. The lane scheduler spec (T3 / lane-scheduler-spec.md) uses
// mkdir-based locking for the same reason — macOS has no `flock(1)` and
// mkdir is atomic on every POSIX filesystem.
//
// The helper is intentionally synchronous: the closed.json writers are sync
// (called from a sync close-out path inside the pipeline runner), so async
// would cascade through every test and caller. Polling uses `Atomics.wait`
// on a tiny SharedArrayBuffer, which blocks the current thread without
// busy-waiting — the Node-standard sync sleep primitive.

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Lock directory name placed next to closed.json. */
const LOCK_DIRNAME = '.closed.json.lock';

/** Force-release a lock that's been held longer than this. */
const DEFAULT_STALE_AFTER_MS = 75_000;

/** Maximum total wait when acquiring. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

/** Polling interval while waiting for a held lock to free. */
const POLL_INTERVAL_MS = 50;

export interface WithClosedJsonLockOptions {
  /** Override stale-lock force-release age (ms). */
  staleAfterMs?: number;
  /** Override acquisition timeout (ms). */
  acquireTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sync sleep for tests. */
  sleep?: (ms: number) => void;
}

/**
 * Run `fn` while holding an exclusive cross-process lock on closed.json.
 *
 * Acquisition: `mkdirSync(.closed.json.lock)` atomically — if it succeeds, we
 * hold the lock. If it fails with `EEXIST`, retry with a small sync sleep. If
 * the existing lock directory is older than `staleAfterMs`, force-release it
 * (assume the holder crashed).
 *
 * Release happens in a `finally`, so a throw in `fn` still releases the lock.
 */
export function withClosedJsonLock<T>(
  closedDir: string,
  fn: () => T,
  opts: WithClosedJsonLockOptions = {},
): T {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSyncSleep;

  const lockPath = join(closedDir, LOCK_DIRNAME);
  const deadline = now() + acquireTimeoutMs;

  while (true) {
    try {
      mkdirSync(lockPath);
      break; // acquired
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      if (isLockStale(lockPath, now(), staleAfterMs)) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        } catch {
          // Lost the race to clear — fall through to the wait loop.
        }
      }
      if (now() >= deadline) {
        throw new Error(
          `withClosedJsonLock: timed out after ${acquireTimeoutMs}ms acquiring ${lockPath}`,
        );
      }
      sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best-effort: a failed release just means the next acquirer will see
      // a stale-lock and force-release it after staleAfterMs.
    }
  }
}

function isEEXIST(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'EEXIST'
  );
}

function isLockStale(lockPath: string, nowMs: number, staleAfterMs: number): boolean {
  try {
    const st = statSync(lockPath);
    return nowMs - st.mtimeMs > staleAfterMs;
  } catch {
    // Couldn't stat — treat as not-stale so we don't accidentally clobber a
    // valid lock when the filesystem hiccups.
    return false;
  }
}

/**
 * Block the current thread for `ms` milliseconds without busy-waiting.
 * `Atomics.wait` is the Node-standard sync sleep primitive — it works on
 * the main thread (unlike the browser, where it throws there).
 */
function defaultSyncSleep(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}
