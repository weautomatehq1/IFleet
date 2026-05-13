import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionSprint } from '../sprint';
import { makeManager, MockAdapter } from './helpers';

test('transition table: queued → running is valid', () => {
  assert.equal(canTransitionSprint('queued', 'running'), true);
});

test('transition table: queued → completed is invalid', () => {
  assert.equal(canTransitionSprint('queued', 'completed'), false);
});

test('transition table: running → completed is valid', () => {
  assert.equal(canTransitionSprint('running', 'completed'), true);
});

test('transition table: terminal states cannot transition', () => {
  assert.equal(canTransitionSprint('cancelled', 'running'), false);
  assert.equal(canTransitionSprint('completed', 'running'), false);
  assert.equal(canTransitionSprint('failed', 'running'), false);
});

test('transition table: running → cancelled is valid', () => {
  assert.equal(canTransitionSprint('running', 'cancelled'), true);
});

test('startSprint: creates sprint in queued state with tasks', () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'test',
      newTaskBriefs: ['brief-1', 'brief-2'],
    });
    assert.equal(rec.state.kind, 'queued');
    assert.equal(rec.tasks.length, 2);
    assert.equal(rec.goal, 'test');
    const reloaded = h.env.store.loadSprint(rec.id);
    assert.equal(reloaded?.tasks.length, 2);
  } finally {
    h.env.cleanup();
  }
});

test('invalid transition throws', () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 't' });
    assert.throws(() =>
      h.manager.transition(rec.id, { kind: 'completed', at: 0, prs: [] }),
    );
  } finally {
    h.env.cleanup();
  }
});

test('tick: dispatches pending tasks and completes sprint', async () => {
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 0, pr: 'PR-1' }) });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    // Wait for adapter to resolve (setTimeout 0)
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const finalRec = h.env.store.loadSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'completed');
    if (finalRec?.state.kind === 'completed') {
      assert.deepEqual(finalRec.state.prs, ['PR-1']);
    }
  } finally {
    h.env.cleanup();
  }
});

test('tick: marks sprint failed when task fails', async () => {
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 1 }) });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const finalRec = h.env.store.loadSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'failed');
  } finally {
    h.env.cleanup();
  }
});

test('tick: skips dispatch when worker is under pressure', async () => {
  const adapter = new MockAdapter({ controllable: true });
  const h = makeManager({ adapter });
  try {
    h.pressure.recordHeaders('w1', {
      tokensRemaining: 1,
      tokensLimit: 100,
      resetAt: Date.now() + 60_000,
    });
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    assert.equal(adapter.spawned.length, 0);
  } finally {
    h.env.cleanup();
  }
});

test('cancelSprint: transitions to cancelled and cancels in-flight tasks', async () => {
  const adapter = new MockAdapter({ controllable: true });
  const h = makeManager({ adapter });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 5));
    const cancelled = await h.manager.cancelSprint(rec.id, 'user-requested');
    assert.equal(cancelled.state.kind, 'cancelled');
    if (cancelled.state.kind === 'cancelled') {
      assert.equal(cancelled.state.reason, 'user-requested');
    }
    assert.equal(adapter.cancelled.length, 1);
  } finally {
    h.env.cleanup();
  }
});

test('cancelSprint: throws when sprint missing', async () => {
  const h = makeManager();
  try {
    await assert.rejects(() =>
      h.manager.cancelSprint('sp_missing' as never, 'r'),
    );
  } finally {
    h.env.cleanup();
  }
});

test('tick: blocks task with missing capability, emits task.capability_blocked', async () => {
  const caps = { version: '1', updated: '', shells: ['bash'], clis: { node: '24' }, mcps: [], auth: {} };
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 0 }), capabilities: caps });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
      newTaskRequirements: [['docker']],
    });
    await h.manager.tick(rec.id);
    assert.equal(h.adapter.spawned.length, 0);
    const task = h.env.store.loadTask(rec.tasks[0]!);
    assert.equal(task?.state.kind, 'failed');
    if (task?.state.kind === 'failed') assert.match(task.state.error, /docker/);
    const blocked = h.events.find((e) => e.kind === 'task.capability_blocked');
    assert.ok(blocked, 'expected task.capability_blocked event');
    assert.deepEqual(blocked?.payload.missing, ['docker']);
  } finally {
    h.env.cleanup();
  }
});

test('tick: dispatches task when required capability is available', async () => {
  const caps = { version: '1', updated: '', shells: ['bash'], clis: { node: '24' }, mcps: [], auth: {} };
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 0, pr: 'PR-1' }), capabilities: caps });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
      newTaskRequirements: [['node']],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    assert.equal(h.adapter.spawned.length, 1);
    assert.equal(h.env.store.loadSprint(rec.id)?.state.kind, 'completed');
  } finally {
    h.env.cleanup();
  }
});

test('tick: dispatches task with no requirements regardless of capabilities', async () => {
  const caps = { version: '1', updated: '', shells: [], clis: {}, mcps: [], auth: {} };
  const h = makeManager({ adapter: new MockAdapter({ controllable: true }), capabilities: caps });
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1'] });
    await h.manager.tick(rec.id);
    assert.equal(h.adapter.spawned.length, 1);
  } finally {
    h.env.cleanup();
  }
});

test('cancelSprint: is idempotent on terminal state', async () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g' });
    await h.manager.cancelSprint(rec.id, 'first');
    const second = await h.manager.cancelSprint(rec.id, 'second');
    assert.equal(second.state.kind, 'cancelled');
  } finally {
    h.env.cleanup();
  }
});
