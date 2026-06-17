/**
 * AUDIT-IFleet-3db72bd3 / 7b13a148 — sprint-bridge event-kind dispatch.
 *
 * Verifies that wireSprintCompletion routes terminal sprint events to the
 * correct adapter method:
 *   sprint.cancelled → adapter.markCancelled  (store: 'blocked'+cancelled:true)
 *   sprint.failed    → adapter.markFailed     (store: 'failed')
 *
 * These tests use a recording UnifiedQueueAdapter so we can assert which
 * method was called without touching the full orchestrator stack.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wireSprintCompletion } from '../sprint-bridge.js';
import { TaskStore } from '../../../queue/store.js';
import { UnifiedQueueAdapter } from '../../../queue/unified-adapter.js';
import type { QueuedTask } from '../../../contracts/task.js';
import type { OrchestratorEvent, SprintId } from '../../types.js';
import type { TaskSource } from '../../../queue/sources/base.js';
import { EventEmitter } from 'node:events';

// ── helpers ───────────────────────────────────────────────────────────────────

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-sb-'));
  const store = new TaskStore(join(dir, 'tasks.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface RecordingSource extends TaskSource {
  calls: string[];
}

function mockSource(kind: 'github' | 'discord'): RecordingSource {
  const calls: string[] = [];
  const source: TaskSource = {
    kind,
    drain: async () => 0,
    markPicked: async (t) => { calls.push(`picked:${t.id}`); },
    markCompleted: async (t, pr) => { calls.push(`completed:${t.id}:${pr}`); },
    markFailed: async (t, reason) => { calls.push(`failed:${t.id}:${reason}`); },
    markBlocked: async (t, cap) => { calls.push(`blocked:${t.id}:${cap}`); },
  };
  return Object.assign(source, { calls });
}

function ghTask(id: string): QueuedTask {
  return {
    id,
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: `node_${id}`,
      url: `https://github.com/weautomatehq1/IFleet/issues/1`,
    },
    repo: 'weautomatehq1/IFleet',
    brief: 'test brief',
    title: 'test task',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey: `gh:${id}`,
  };
}

/**
 * Minimal orchestrator stub that exposes an event bus and a getSprint() stub.
 * wireSprintCompletion only calls orchestrator.on/off/getSprint.
 */
function makeOrchestrator(sprintId: SprintId, sprintState?: { kind: 'cancelled'; reason: string } | { kind: 'failed'; error: string }) {
  const emitter = new EventEmitter();
  return {
    on: (event: string, cb: (...args: unknown[]) => void) => { emitter.on(event, cb); },
    off: (event: string, cb: (...args: unknown[]) => void) => { emitter.off(event, cb); },
    getSprint: (_id: SprintId) => sprintState ? { state: sprintState } : undefined,
    emit: (event: OrchestratorEvent) => { emitter.emit('event', event); },
  };
}

function makeEvent(sprintId: SprintId, kind: string): OrchestratorEvent {
  return { ts: Date.now(), sprintId, kind, payload: {} };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('wireSprintCompletion — cancel vs. fail dispatch (AUDIT-IFleet-3db72bd3/7b13a148)', () => {
  test('sprint.cancelled → adapter.markCancelled, store row becomes blocked+cancelled:true', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const task = ghTask('sb-cancel-1');
      store.insert(task);
      // Mark in_flight so the adapter can operate on it
      store.updateState(task.id, 'in_flight', {});

      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });
      const sprintId = 'sp-cancel-1' as SprintId;
      const orchestrator = makeOrchestrator(sprintId, { kind: 'cancelled', reason: 'operator /cancel' });

      wireSprintCompletion(
        sprintId,
        task,
        adapter,
        orchestrator as never,
        store,
      );

      // Fire the sprint.cancelled terminal event
      orchestrator.emit(makeEvent(sprintId, 'sprint.cancelled'));

      // Allow the void async chain to settle
      await new Promise<void>((r) => setImmediate(r));

      const row = store.getById(task.id);
      assert.ok(row, 'task row must exist');
      assert.equal(row!.state, 'blocked', 'sprint.cancelled must record blocked, not failed');
      assert.notEqual(row!.state, 'failed', 'sprint.cancelled must NOT record failed');
      assert.equal(row!.stateMeta?.['cancelled'], true, 'cancelled:true must be set');
    } finally {
      cleanup();
    }
  });

  test('sprint.failed → adapter.markFailed, store row becomes failed (genuine failure preserved)', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const task = ghTask('sb-fail-1');
      store.insert(task);
      store.updateState(task.id, 'in_flight', {});

      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });
      const sprintId = 'sp-fail-1' as SprintId;
      const orchestrator = makeOrchestrator(sprintId, { kind: 'failed', error: 'pipeline crash' });

      wireSprintCompletion(
        sprintId,
        task,
        adapter,
        orchestrator as never,
        store,
      );

      orchestrator.emit(makeEvent(sprintId, 'sprint.failed'));
      await new Promise<void>((r) => setImmediate(r));

      const row = store.getById(task.id);
      assert.ok(row, 'task row must exist');
      assert.equal(row!.state, 'failed', 'sprint.failed must record failed');
      assert.notEqual(row!.stateMeta?.['cancelled'], true, 'failed row must not have cancelled:true');
    } finally {
      cleanup();
    }
  });

  test('sprint.cancelled does not call adapter.markFailed (spy-level assertion)', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const task = ghTask('sb-spy-1');
      store.insert(task);
      store.updateState(task.id, 'in_flight', {});

      const markFailedCalls: string[] = [];
      const markCancelledCalls: string[] = [];

      // Wrap UnifiedQueueAdapter to spy on the two methods
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });
      const originalMarkFailed = adapter.markFailed.bind(adapter);
      const originalMarkCancelled = adapter.markCancelled.bind(adapter);
      adapter.markFailed = async (t, r) => { markFailedCalls.push(t.id); return originalMarkFailed(t, r); };
      adapter.markCancelled = async (t, r) => { markCancelledCalls.push(t.id); return originalMarkCancelled(t, r); };

      const sprintId = 'sp-spy-1' as SprintId;
      const orchestrator = makeOrchestrator(sprintId, { kind: 'cancelled', reason: 'deliberate' });

      wireSprintCompletion(sprintId, task, adapter, orchestrator as never, store);
      orchestrator.emit(makeEvent(sprintId, 'sprint.cancelled'));
      await new Promise<void>((r) => setImmediate(r));

      assert.deepEqual(markCancelledCalls, [task.id], 'markCancelled must be called for sprint.cancelled');
      assert.deepEqual(markFailedCalls, [], 'markFailed must NOT be called for sprint.cancelled');
    } finally {
      cleanup();
    }
  });

  test('sprint.failed does not call adapter.markCancelled (spy-level assertion)', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const task = ghTask('sb-spy-2');
      store.insert(task);
      store.updateState(task.id, 'in_flight', {});

      const markFailedCalls: string[] = [];
      const markCancelledCalls: string[] = [];

      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });
      const originalMarkFailed = adapter.markFailed.bind(adapter);
      const originalMarkCancelled = adapter.markCancelled.bind(adapter);
      adapter.markFailed = async (t, r) => { markFailedCalls.push(t.id); return originalMarkFailed(t, r); };
      adapter.markCancelled = async (t, r) => { markCancelledCalls.push(t.id); return originalMarkCancelled(t, r); };

      const sprintId = 'sp-spy-2' as SprintId;
      const orchestrator = makeOrchestrator(sprintId, { kind: 'failed', error: 'crash' });

      wireSprintCompletion(sprintId, task, adapter, orchestrator as never, store);
      orchestrator.emit(makeEvent(sprintId, 'sprint.failed'));
      await new Promise<void>((r) => setImmediate(r));

      assert.deepEqual(markFailedCalls, [task.id], 'markFailed must be called for sprint.failed');
      assert.deepEqual(markCancelledCalls, [], 'markCancelled must NOT be called for sprint.failed');
    } finally {
      cleanup();
    }
  });
});
