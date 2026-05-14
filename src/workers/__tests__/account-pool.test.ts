import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountPool, AccountPoolEmptyError } from '../account-pool.ts';
import type { WorkerConfig } from '../../orchestrator/types.ts';

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
