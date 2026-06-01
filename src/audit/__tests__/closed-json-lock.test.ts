import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withClosedJsonLock } from '../closed-json-lock.js';

const LOCK_DIRNAME = '.closed.json.lock';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'closed-json-lock-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('withClosedJsonLock', () => {
  it('acquires, runs the callback, and releases the lock', () => {
    let ran = false;
    const result = withClosedJsonLock(workDir, () => {
      ran = true;
      expect(existsSync(join(workDir, LOCK_DIRNAME))).toBe(true);
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(existsSync(join(workDir, LOCK_DIRNAME))).toBe(false);
  });

  it('releases the lock when the callback throws', () => {
    expect(() =>
      withClosedJsonLock(workDir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(workDir, LOCK_DIRNAME))).toBe(false);
  });

  it('force-releases a stale lock', () => {
    // Plant a lock directory and backdate its mtime well past stale threshold.
    mkdirSync(join(workDir, LOCK_DIRNAME));
    const fakeNow = Date.now() + 5_000_000; // far in the future relative to mtime
    const sleep = vi.fn();
    const result = withClosedJsonLock(
      workDir,
      () => 'cleared',
      { now: () => fakeNow, sleep, staleAfterMs: 75_000 },
    );
    expect(result).toBe('cleared');
    expect(sleep).not.toHaveBeenCalled(); // stale → cleared in first iteration
  });

  it('polls and serialises waiters when the lock is held by a non-stale holder', () => {
    // Plant a fresh lock directory — looks like another process is holding it.
    mkdirSync(join(workDir, LOCK_DIRNAME));
    // Sanity: ensure the planted lock is fresh per stat
    const st = statSync(join(workDir, LOCK_DIRNAME));
    expect(Date.now() - st.mtimeMs).toBeLessThan(75_000);

    // Stub sleep to remove the held lock on the second call — simulating the
    // other holder finishing.
    let sleepCalls = 0;
    const sleep = vi.fn(() => {
      sleepCalls++;
      if (sleepCalls === 2) {
        rmSync(join(workDir, LOCK_DIRNAME), { recursive: true, force: true });
      }
    });

    const result = withClosedJsonLock(
      workDir,
      () => 'eventually-acquired',
      { sleep, acquireTimeoutMs: 5_000, staleAfterMs: 75_000 },
    );
    expect(result).toBe('eventually-acquired');
    expect(sleepCalls).toBeGreaterThanOrEqual(2);
  });

  it('throws on acquisition timeout', () => {
    mkdirSync(join(workDir, LOCK_DIRNAME));
    // Use a synthetic clock so we can blow past the timeout without real waiting.
    let t = 0;
    const sleep = vi.fn(() => {
      t += 1000;
    });
    expect(() =>
      withClosedJsonLock(
        workDir,
        () => 'never',
        {
          now: () => t,
          sleep,
          acquireTimeoutMs: 2_000,
          staleAfterMs: 75_000,
        },
      ),
    ).toThrow(/timed out after 2000ms/);
  });

  it('does not leave a lock directory behind on the success path', () => {
    withClosedJsonLock(workDir, () => 'done');
    expect(existsSync(join(workDir, LOCK_DIRNAME))).toBe(false);
  });

  it('callbacks run serially when called back-to-back (single process)', () => {
    const order: number[] = [];
    withClosedJsonLock(workDir, () => order.push(1));
    withClosedJsonLock(workDir, () => order.push(2));
    withClosedJsonLock(workDir, () => order.push(3));
    expect(order).toEqual([1, 2, 3]);
  });
});
