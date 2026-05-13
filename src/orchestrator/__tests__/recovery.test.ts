import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PressureTracker } from '../pressure';
import { SprintManager } from '../sprint';
import { StateStore } from '../store';
import { WorkerRegistry } from '../workers';
import { MockAdapter, noopBriefLoader } from './helpers';
import type { OrchestratorEvent, SprintRecord, TaskRecord } from '../types';

function makeStandalone(): {
  dir: string;
  dbPath: string;
  workersConfig: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-rec-'));
  const dbPath = join(dir, 'state.db');
  const workersConfig = join(dir, 'workers.json');
  writeFileSync(
    workersConfig,
    JSON.stringify({
      workers: [{ id: 'w1', provider: 'claude', maxConcurrent: 1, enabled: true }],
    }),
  );
  return {
    dir,
    dbPath,
    workersConfig,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('crash recovery: resumeAbandoned resets running tasks to pending', () => {
  const env = makeStandalone();
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({
      configPath: env.workersConfig,
      watchFs: false,
    });
    // Manually craft a "running" sprint with a "running" task.
    const sprintId = 'sp_crashed' as SprintRecord['id'];
    const taskId = 'tk_crashed' as TaskRecord['id'];
    const now = 1000;
    store.saveSprint({
      id: sprintId,
      mode: 'normal',
      goal: 'crashed',
      tasks: [taskId],
      state: { kind: 'running', startedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    store.saveTask({
      id: taskId,
      sprintId,
      brief: 'b',
      state: { kind: 'running', workerId: 'w1', startedAt: now },
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });

    const events: OrchestratorEvent[] = [];
    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter: new MockAdapter(),
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
    });
    const resumed = mgr.resumeAbandoned();
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0], sprintId);
    const t = store.loadTask(taskId);
    assert.equal(t?.state.kind, 'pending');
    assert.ok(events.some((e) => e.kind === 'sprint.resumed'));
    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

test('crash recovery: no abandoned sprints to resume returns empty', () => {
  const env = makeStandalone();
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({
      configPath: env.workersConfig,
      watchFs: false,
    });
    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter: new MockAdapter(),
      briefLoader: noopBriefLoader,
      emit: () => undefined,
    });
    assert.deepEqual(mgr.resumeAbandoned(), []);
    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

test('state store: migrations are idempotent', () => {
  const env = makeStandalone();
  try {
    const store1 = new StateStore(env.dbPath);
    store1.close();
    // Re-open — should not throw.
    const store2 = new StateStore(env.dbPath);
    store2.close();
  } finally {
    env.cleanup();
  }
});

test('state store: appendEvent + latestPressure round-trip', () => {
  const env = makeStandalone();
  try {
    const store = new StateStore(env.dbPath);
    store.saveRateLimit({
      workerId: 'w1',
      tokensRemaining: 42,
      tokensLimit: 100,
      resetAt: 9999,
      pressure: 0.58,
      observedAt: 1234,
    });
    const snap = store.latestPressure('w1');
    assert.equal(snap?.tokensRemaining, 42);
    assert.equal(snap?.pressure, 0.58);
    store.appendEvent({
      ts: 1,
      sprintId: 'sp_x' as SprintRecord['id'],
      kind: 'test.event',
      payload: { hello: 'world' },
    });
    store.close();
  } finally {
    env.cleanup();
  }
});
