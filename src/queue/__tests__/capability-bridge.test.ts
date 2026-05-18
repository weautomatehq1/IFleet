import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CapabilityBridge } from '../capability-bridge.js';
import type { OrchestratorEvent } from '../../orchestrator/types.js';
import type { QueueAdapter, QueuedTask } from '../types.js';

function makeTask(issueNumber = 42): QueuedTask {
  return {
    id: 'node-id',
    repo: 'owner/repo',
    issueNumber,
    title: 't',
    body: '',
    author: '',
    labels: ['auto:ship'],
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: 0,
    url: 'u',
  };
}

interface FakeSource {
  emit(kind: string, event: OrchestratorEvent): void;
  on(event: string, cb: (e: OrchestratorEvent) => void): unknown;
}

function makeSource(): FakeSource {
  const handlers = new Map<string, Array<(e: OrchestratorEvent) => void>>();
  return {
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit(kind, event) {
      for (const cb of handlers.get(kind) ?? []) cb(event);
    },
  };
}

interface BlockedCall { task: QueuedTask; missing: string[] }

function makeQueue(): { adapter: QueueAdapter; blocked: BlockedCall[] } {
  const blocked: BlockedCall[] = [];
  const adapter: QueueAdapter = {
    pickNext: async () => null,
    markPicked: async () => undefined,
    markCompleted: async () => undefined,
    markFailed: async () => undefined,
    markCapabilityBlocked: async (task, missing) => { blocked.push({ task, missing }); },
    postStatus: async () => undefined,
    watchForNew: () => ({ stop: () => undefined }),
  };
  return { adapter, blocked };
}

function makeEvent(kind: string, taskId?: string, payload: Record<string, unknown> = {}): OrchestratorEvent {
  return { ts: 0, sprintId: 'sp_1' as never, taskId: taskId as never, kind, payload };
}

describe('CapabilityBridge', () => {
  it('calls markCapabilityBlocked for a registered task', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    const bridge = new CapabilityBridge(source, adapter);
    bridge.register('tk_1', makeTask(42));

    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.task.issueNumber, 42);
    assert.deepEqual(blocked[0]?.missing, ['docker']);
  });

  it('ignores task.capability_blocked for unregistered taskId', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    new CapabilityBridge(source, adapter);

    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_unknown', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 0);
  });

  it('ignores events with no taskId', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    new CapabilityBridge(source, adapter);

    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', undefined, { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 0);
  });

  it('removes task from map after blocking so duplicate events are no-ops', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    const bridge = new CapabilityBridge(source, adapter);
    bridge.register('tk_1', makeTask(42));

    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 1);
  });

  it('cleans up map when task.completed fires', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    const bridge = new CapabilityBridge(source, adapter);
    bridge.register('tk_1', makeTask(42));

    source.emit('task.completed', makeEvent('task.completed', 'tk_1'));
    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 0);
  });

  it('cleans up map when task.failed fires', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    const bridge = new CapabilityBridge(source, adapter);
    bridge.register('tk_1', makeTask(42));

    source.emit('task.failed', makeEvent('task.failed', 'tk_1'));
    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 0);
  });

  it('unregister removes task immediately', async () => {
    const source = makeSource();
    const { adapter, blocked } = makeQueue();
    const bridge = new CapabilityBridge(source, adapter);
    bridge.register('tk_1', makeTask(42));
    bridge.unregister('tk_1');

    source.emit('task.capability_blocked', makeEvent('task.capability_blocked', 'tk_1', { missing: ['docker'] }));
    await Promise.resolve();

    assert.equal(blocked.length, 0);
  });
});
