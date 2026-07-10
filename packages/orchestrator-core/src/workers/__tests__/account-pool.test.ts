import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountPool,
  AccountPoolEmptyError,
  AllAccountsPausedError,
} from '../account-pool.ts';
import type { WorkerConfig } from '../../../../../src/orchestrator/types.ts';

function makeWorker(overrides: Partial<WorkerConfig> & Pick<WorkerConfig, 'id'>): WorkerConfig {
  return {
    provider: 'claude',
    maxConcurrent: 1,
    enabled: true,
    ...overrides,
  };
}

test('account-pool: cycles through enabled workers in order', () => {
  const workers: WorkerConfig[] = [
    makeWorker({ id: 'claude-max-1', authProfile: 'default' }),
    makeWorker({ id: 'claude-max-2', authProfile: 'claude-max-2' }),
    makeWorker({ id: 'claude-max-3', authProfile: 'claude-max-3' }),
  ];
  const pool = createAccountPool(workers);
  assert.equal(pool.workerCount(), 3);
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  assert.equal(pool.nextWorker().id, 'claude-max-2');
  assert.equal(pool.nextWorker().id, 'claude-max-3');
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  assert.equal(pool.nextWorker().id, 'claude-max-2');
});

test('account-pool: skips disabled workers', () => {
  const workers: WorkerConfig[] = [
    makeWorker({ id: 'claude-max-1' }),
    makeWorker({ id: 'claude-max-2', enabled: false }),
    makeWorker({ id: 'claude-max-3' }),
    makeWorker({ id: 'claude-max-4', enabled: false }),
  ];
  const pool = createAccountPool(workers);
  assert.equal(pool.workerCount(), 2);
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  assert.equal(pool.nextWorker().id, 'claude-max-3');
  assert.equal(pool.nextWorker().id, 'claude-max-1');
});

test('account-pool: skips non-claude providers', () => {
  const workers: WorkerConfig[] = [
    makeWorker({ id: 'claude-max-1' }),
    makeWorker({ id: 'codex-pro-1', provider: 'codex' }),
  ];
  const pool = createAccountPool(workers);
  assert.equal(pool.workerCount(), 1);
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  assert.equal(pool.nextWorker().id, 'claude-max-1');
});

test('account-pool: returns the only available worker repeatedly when only one is enabled', () => {
  const workers: WorkerConfig[] = [
    makeWorker({ id: 'claude-max-1' }),
    makeWorker({ id: 'claude-max-2', enabled: false }),
  ];
  const pool = createAccountPool(workers);
  assert.equal(pool.workerCount(), 1);
  for (let i = 0; i < 5; i++) {
    assert.equal(pool.nextWorker().id, 'claude-max-1');
  }
});

test('account-pool: throws AccountPoolEmptyError when no claude workers are enabled', () => {
  const pool = createAccountPool([
    makeWorker({ id: 'codex-pro-1', provider: 'codex' }),
    makeWorker({ id: 'claude-max-1', enabled: false }),
  ]);
  assert.equal(pool.workerCount(), 0);
  assert.throws(() => pool.nextWorker(), AccountPoolEmptyError);
});

test('account-pool: markRateLimited skips paused worker until pause expires', () => {
  let t = 1_000_000;
  const pool = createAccountPool(
    [
      makeWorker({ id: 'claude-max-1' }),
      makeWorker({ id: 'claude-max-2' }),
      makeWorker({ id: 'claude-max-3' }),
    ],
    { now: () => t },
  );

  // Burn one slot so the cursor advances past claude-max-1.
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  // Pause #2 — next pick must skip it.
  pool.markRateLimited('claude-max-2', 30_000);
  assert.equal(pool.nextWorker().id, 'claude-max-3');
  // Still paused — cycling around skips #2 again.
  assert.equal(pool.nextWorker().id, 'claude-max-1');
  assert.equal(pool.nextWorker().id, 'claude-max-3');
  // Advance past the pause — #2 is back in rotation.
  t += 30_001;
  const ids = [pool.nextWorker().id, pool.nextWorker().id, pool.nextWorker().id].sort();
  assert.deepEqual(ids, ['claude-max-1', 'claude-max-2', 'claude-max-3']);
});

test('account-pool: markAuthFailed disables worker permanently', () => {
  let t = 0;
  const pool = createAccountPool(
    [
      makeWorker({ id: 'claude-max-1' }),
      makeWorker({ id: 'claude-max-2' }),
    ],
    { now: () => t },
  );
  pool.markAuthFailed('claude-max-1');
  for (let i = 0; i < 5; i++) {
    assert.equal(pool.nextWorker().id, 'claude-max-2');
    t += 60_000;
  }
});

test('account-pool: nextWorker throws AllAccountsPausedError when every worker is paused', () => {
  const t = 1_000;
  const pool = createAccountPool(
    [
      makeWorker({ id: 'claude-max-1' }),
      makeWorker({ id: 'claude-max-2' }),
    ],
    { now: () => t },
  );
  pool.markRateLimited('claude-max-1', 2_000);
  pool.markRateLimited('claude-max-2', 5_000);
  assert.throws(
    () => pool.nextWorker(),
    (err: unknown) => {
      assert.ok(err instanceof AllAccountsPausedError);
      assert.equal(err.nextAvailableMs, 2_000);
      return true;
    },
  );
});

test('account-pool: acquire returns discriminated result', () => {
  const t = 1_000;
  const pool = createAccountPool(
    [makeWorker({ id: 'claude-max-1' }), makeWorker({ id: 'claude-max-2' })],
    { now: () => t },
  );

  const ok = pool.acquire();
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') assert.equal(ok.worker.id, 'claude-max-1');

  pool.markRateLimited('claude-max-1', 5_000);
  pool.markRateLimited('claude-max-2', 1_500);
  const allPaused = pool.acquire();
  assert.equal(allPaused.kind, 'all_paused');
  if (allPaused.kind === 'all_paused') {
    assert.equal(allPaused.nextAvailableMs, 1_500);
  }

  const emptyPool = createAccountPool([makeWorker({ id: 'claude-max-1', enabled: false })]);
  assert.deepEqual(emptyPool.acquire(), { kind: 'empty' });
});

test('account-pool: markRateLimited with 0ms clears pause; longer pause is not shortened', () => {
  const t = 1_000;
  const pool = createAccountPool(
    [makeWorker({ id: 'claude-max-1' })],
    { now: () => t },
  );
  pool.markRateLimited('claude-max-1', 10_000);
  // A shorter pause cannot shorten the existing one.
  pool.markRateLimited('claude-max-1', 1_000);
  assert.throws(() => pool.nextWorker(), AllAccountsPausedError);
  // 0ms is the explicit "clear" signal.
  pool.markRateLimited('claude-max-1', 0);
  assert.equal(pool.nextWorker().id, 'claude-max-1');
});

test('account-pool: markRateLimited(0) does not re-enable an auth-failed (permanent) worker', () => {
  const pool = createAccountPool(
    [makeWorker({ id: 'claude-max-1' })],
    { now: () => 1_000 },
  );
  pool.markAuthFailed('claude-max-1');
  assert.throws(() => pool.nextWorker(), AllAccountsPausedError);
  // A 0ms rate-limit clear must NOT revive a permanently banned account.
  pool.markRateLimited('claude-max-1', 0);
  assert.throws(() => pool.nextWorker(), AllAccountsPausedError);
});

test('account-pool: rotation path — first worker rate-limited, pool returns next available', () => {
  const t = 1_000;
  const pool = createAccountPool(
    [
      makeWorker({ id: 'claude-max-1' }),
      makeWorker({ id: 'claude-max-2' }),
      makeWorker({ id: 'claude-max-3' }),
    ],
    { now: () => t },
  );

  // Orchestrator: pick a worker, get rate-limited, pause it, pick again.
  const first = pool.nextWorker();
  assert.equal(first.id, 'claude-max-1');
  pool.markRateLimited(first.id, 60_000);

  const second = pool.nextWorker();
  assert.notEqual(second.id, 'claude-max-1');
  pool.markRateLimited(second.id, 60_000);

  const third = pool.nextWorker();
  assert.notEqual(third.id, 'claude-max-1');
  assert.notEqual(third.id, second.id);
});
