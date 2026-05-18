import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, rmSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { acquireDispatchLock } from '../dispatcher-lock.ts';

function tmpLock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-disp-'));
  return join(dir, '.omc', 'dispatcher.lock');
}

describe('acquireDispatchLock', () => {
  it('first acquirer wins and writes its PID', () => {
    const path = tmpLock();
    const result = acquireDispatchLock(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.pid).toBe(process.pid);
    expect(existsSync(path)).toBe(true);
    result.lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('second concurrent acquirer is denied when first PID is alive', () => {
    const path = tmpLock();
    const first = acquireDispatchLock(path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = acquireDispatchLock(path);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('held-by-live-pid');
    expect(second.heldByPid).toBe(process.pid);

    first.lock.release();
  });

  it('reclaims lock when holder PID is dead', () => {
    const path = tmpLock();
    // Sentinel PID no live process owns. On POSIX, kill(2147483647, 0)
    // throws ESRCH; on Windows it also throws (no such process).
    const deadPid = 2147483647;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(deadPid), 'utf8');

    const result = acquireDispatchLock(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lock.pid).toBe(process.pid);
    result.lock.release();
  });

  it('reclaims lock when file is older than 30 minutes regardless of PID', () => {
    const path = tmpLock();
    mkdirSync(dirname(path), { recursive: true });
    // PID is ours (alive) but mtime is ancient -> stale-by-age path.
    writeFileSync(path, String(process.pid), 'utf8');
    const ancient = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(path, ancient, ancient);

    const result = acquireDispatchLock(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lock.release();
  });

  it('release is idempotent and only deletes our own PID', () => {
    const path = tmpLock();
    const result = acquireDispatchLock(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lock.release();
    // Second call must not throw, even though the file is gone.
    result.lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('release does NOT delete the lock when another process now owns it', () => {
    const path = tmpLock();
    const first = acquireDispatchLock(path);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Simulate another process reclaiming the lock by overwriting PID.
    writeFileSync(path, '99999', 'utf8');

    // Our release should be a no-op because the file no longer holds our PID.
    first.lock.release();
    expect(existsSync(path)).toBe(true);

    rmSync(path);
  });

  it('creates the parent .omc directory if missing', () => {
    const path = tmpLock();
    expect(existsSync(dirname(path))).toBe(false);
    const result = acquireDispatchLock(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(dirname(path))).toBe(true);
    result.lock.release();
  });
});
