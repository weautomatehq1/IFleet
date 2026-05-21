/**
 * Integration tests: wireSprintCompletion() → TaskStore.recordPrDecision()
 *
 * Asserts that:
 *   1. sprint.completed + PR URL writes a 'merged' row with the pr_number
 *      extracted from the URL and reviewer_login = null.
 *   2. sprint.failed + prior PR URL writes an 'abandoned' row.
 *   3. sprint.failed without any PR URL writes NO row (graceful skip).
 *   4. sprint.cancelled + prior PR URL writes an 'abandoned' row.
 *
 * No subprocess, Docker, Discord, or real Orchestrator. The Orchestrator is
 * replaced by a minimal in-process mock that exposes on/off/emit/getSprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireSprintCompletion } from '../daemon.js';
import { TaskStore } from '../../queue/store.js';
import type { OrchestratorEvent, SprintId } from '../types.js';
import type { QueuedTask } from '../../contracts/task.js';
import type { UnifiedQueueAdapter } from '../../queue/unified-adapter.js';
import type { Orchestrator } from '../index.js';

// ---------------------------------------------------------------------------
// Minimal mock types
// ---------------------------------------------------------------------------

type EventHandler = (event: OrchestratorEvent) => void;

class MockOrchestrator {
  private readonly listeners = new Map<string, EventHandler[]>();

  on(_event: 'event', fn: EventHandler): void {
    const arr = this.listeners.get('event') ?? [];
    arr.push(fn);
    this.listeners.set('event', arr);
  }

  off(_event: 'event', fn: EventHandler): void {
    const arr = this.listeners.get('event') ?? [];
    this.listeners.set('event', arr.filter((f) => f !== fn));
  }

  emit(event: OrchestratorEvent): void {
    const arr = this.listeners.get('event') ?? [];
    for (const fn of arr) fn(event);
  }

  getSprint(_id: SprintId): undefined { return undefined; }
}

function makeAdapter(): UnifiedQueueAdapter {
  return {
    markCompleted: async () => undefined,
    markFailed: async () => undefined,
    pickNext: async () => null,
  } as unknown as UnifiedQueueAdapter;
}

function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: 'task-pr-test-1',
    repo: 'weautomatehq1/IFleet',
    title: 'test task',
    brief: 'brief',
    idempotencyKey: 'key-1',
    createdAt: 0,
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: 'N1',
      url: 'https://github.com/weautomatehq1/IFleet/issues/1',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  store: TaskStore;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const workdir = mkdtempSync(join(tmpdir(), 'daemon-pr-decision-'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('sprint.completed + PR URL → merged row with correct pr_number', (_t, done) => {
  const { store, cleanup } = makeFixture();
  const orch = new MockOrchestrator();
  const adapter = makeAdapter();
  const task = makeTask();
  const sprintId = 'sprint-pr-1' as SprintId;
  const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/42';

  store.insert(task);
  wireSprintCompletion(sprintId, task, adapter, orch as unknown as Orchestrator, store);

  // Pipeline: task completes with PR URL, then sprint completes.
  orch.emit({
    ts: 1,
    sprintId,
    taskId: task.id as import('../types.js').TaskId,
    kind: 'task.completed',
    payload: { pr: prUrl },
  });
  orch.emit({ ts: 2, sprintId, kind: 'sprint.completed', payload: {} });

  // markCompleted is fire-and-forget; let microtasks settle.
  setImmediate(() => {
    try {
      const rows = store.getPrDecisionsByRepo(task.repo);
      assert.equal(rows.length, 1, 'exactly one pr_decisions row');
      const row = rows[0]!;
      assert.equal(row.verdict, 'merged');
      assert.equal(row.prNumber, 42);
      assert.equal(row.repo, 'weautomatehq1/IFleet');
      assert.equal(row.taskId, task.id);
      assert.strictEqual(row.reviewerLogin, null);
      done();
    } catch (err) {
      done(err as Error);
    } finally {
      cleanup();
    }
  });
});

test('sprint.failed + prior PR URL → abandoned row', (_t, done) => {
  const { store, cleanup } = makeFixture();
  const orch = new MockOrchestrator();
  const adapter = makeAdapter();
  const task = makeTask({ id: 'task-pr-test-2', idempotencyKey: 'key-2' });
  const sprintId = 'sprint-pr-2' as SprintId;
  const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/77';

  store.insert(task);
  wireSprintCompletion(sprintId, task, adapter, orch as unknown as Orchestrator, store);

  // PR opened mid-sprint, then sprint fails.
  orch.emit({
    ts: 1,
    sprintId,
    taskId: task.id as import('../types.js').TaskId,
    kind: 'task.completed',
    payload: { pr: prUrl },
  });
  orch.emit({ ts: 2, sprintId, kind: 'sprint.failed', payload: { from: 'running', to: 'failed' } });

  setImmediate(() => {
    try {
      const rows = store.getPrDecisionsByRepo(task.repo);
      assert.equal(rows.length, 1, 'exactly one pr_decisions row');
      const row = rows[0]!;
      assert.equal(row.verdict, 'abandoned');
      assert.equal(row.prNumber, 77);
      assert.equal(row.repo, 'weautomatehq1/IFleet');
      assert.equal(row.taskId, task.id);
      assert.strictEqual(row.reviewerLogin, null);
      done();
    } catch (err) {
      done(err as Error);
    } finally {
      cleanup();
    }
  });
});

test('sprint.failed without any PR URL → no row written', (_t, done) => {
  const { store, cleanup } = makeFixture();
  const orch = new MockOrchestrator();
  const adapter = makeAdapter();
  const task = makeTask({ id: 'task-pr-test-3', idempotencyKey: 'key-3' });
  const sprintId = 'sprint-pr-3' as SprintId;

  wireSprintCompletion(sprintId, task, adapter, orch as unknown as Orchestrator, store);

  // Sprint fails before any PR is opened.
  orch.emit({ ts: 1, sprintId, kind: 'sprint.failed', payload: { from: 'running', to: 'failed' } });

  setImmediate(() => {
    try {
      const rows = store.getPrDecisionsByRepo(task.repo);
      assert.equal(rows.length, 0, 'no row when no PR URL was captured');
      done();
    } catch (err) {
      done(err as Error);
    } finally {
      cleanup();
    }
  });
});

test('sprint.cancelled + prior PR URL → abandoned row', (_t, done) => {
  const { store, cleanup } = makeFixture();
  const orch = new MockOrchestrator();
  const adapter = makeAdapter();
  const task = makeTask({ id: 'task-pr-test-4', idempotencyKey: 'key-4' });
  const sprintId = 'sprint-pr-4' as SprintId;
  const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/99';

  store.insert(task);
  wireSprintCompletion(sprintId, task, adapter, orch as unknown as Orchestrator, store);

  orch.emit({
    ts: 1,
    sprintId,
    taskId: task.id as import('../types.js').TaskId,
    kind: 'task.completed',
    payload: { pr: prUrl },
  });
  orch.emit({ ts: 2, sprintId, kind: 'sprint.cancelled', payload: { from: 'running', to: 'cancelled' } });

  setImmediate(() => {
    try {
      const rows = store.getPrDecisionsByRepo(task.repo);
      assert.equal(rows.length, 1, 'exactly one pr_decisions row');
      assert.equal(rows[0]!.verdict, 'abandoned');
      assert.equal(rows[0]!.prNumber, 99);
      done();
    } catch (err) {
      done(err as Error);
    } finally {
      cleanup();
    }
  });
});
