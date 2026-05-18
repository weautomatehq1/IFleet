/**
 * Process-level dispatcher lock to prevent concurrent run-smoke invocations.
 *
 * Why: PM2 cron_restart can spawn overlapping instances when a previous run
 * has not yet exited (or when an MCP/external trigger also fires while the
 * cron is firing). Concurrent dispatchers race through `pickNext()` and both
 * claim the same auto:ship issue before either calls `markPicked` — the
 * label-based check is TOCTOU. Symptom observed 2026-05-15: duplicate
 * "▶ Sprint started" Discord posts 500–1000ms apart for the same issue.
 *
 * Mitigation: atomic O_EXCL lockfile. Each run writes its PID; later runs
 * either find a live PID (and exit cleanly) or detect a stale lock and
 * reclaim it. Process-level lock survives any dispatcher source.
 */
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface DispatchLock {
  release(): void;
  pid: number;
}

export interface AcquireResult {
  ok: true;
  lock: DispatchLock;
}

export interface DeniedResult {
  ok: false;
  reason: 'held-by-live-pid' | 'unknown-error';
  heldByPid?: number;
  error?: string;
}

export type LockResult = AcquireResult | DeniedResult;

const STALE_AFTER_MS = 30 * 60 * 1000; // 30min hard ceiling for a single dispatcher run

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission — treat as alive.
    return code === 'EPERM';
  }
}

function readPidFrom(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isStaleByAge(lockPath: string): boolean {
  try {
    const s = statSync(lockPath);
    return Date.now() - s.mtimeMs > STALE_AFTER_MS;
  } catch {
    return false;
  }
}

function writeAtomic(lockPath: string, pid: number): void {
  // O_EXCL: fail if file exists. Combined with O_CREAT, atomic create.
  const fd = openSync(lockPath, 'wx');
  try {
    writeFileSync(fd, String(pid), { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}

/**
 * Try to acquire the dispatcher lock. Returns:
 *  - ok:true with a release handle if the caller now owns the lock
 *  - ok:false with reason if another live dispatcher holds it (caller should exit 0)
 *
 * Behavior on stale lock (PID dead OR file older than 30min): reclaim.
 */
export function acquireDispatchLock(lockPath: string): LockResult {
  mkdirSync(dirname(lockPath), { recursive: true });
  const ourPid = process.pid;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeAtomic(lockPath, ourPid);
      const release = (): void => {
        try {
          const current = readPidFrom(lockPath);
          // Only delete if we still own it — defend against another process
          // reclaiming a stale lock and us racing it on the way out.
          if (current === ourPid) unlinkSync(lockPath);
        } catch {
          // best-effort
        }
      };
      // Also clean up if the process exits unexpectedly.
      const onExit = (): void => {
        try {
          const current = readPidFrom(lockPath);
          if (current === ourPid) unlinkSync(lockPath);
        } catch {
          // best-effort
        }
      };
      process.once('exit', onExit);
      process.once('SIGINT', () => { onExit(); process.exit(130); });
      process.once('SIGTERM', () => { onExit(); process.exit(143); });
      return { ok: true, lock: { release, pid: ourPid } };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return { ok: false, reason: 'unknown-error', error: (err as Error).message };
      }
      // Lock exists — check if holder is alive.
      const heldByPid = readPidFrom(lockPath);
      const aliveHolder = heldByPid !== null && isPidAlive(heldByPid);
      if (aliveHolder && !isStaleByAge(lockPath)) {
        return { ok: false, reason: 'held-by-live-pid', heldByPid: heldByPid ?? undefined };
      }
      // Stale (dead PID or expired by age) — reclaim by deletion + retry.
      try {
        unlinkSync(lockPath);
      } catch (rmErr) {
        const rmCode = (rmErr as NodeJS.ErrnoException).code;
        if (rmCode !== 'ENOENT') {
          return { ok: false, reason: 'unknown-error', error: (rmErr as Error).message };
        }
      }
      // Loop and retry the atomic create.
    }
  }
  return { ok: false, reason: 'unknown-error', error: 'exceeded retry budget reclaiming stale lock' };
}
