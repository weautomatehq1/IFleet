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
    const completedEvent = h.events.find((e) => e.kind === 'sprint.completed');
    assert.ok(completedEvent, 'sprint.completed event emitted');
    assert.equal(completedEvent?.payload['to'], 'completed');
    assert.ok(typeof completedEvent?.payload['durationMs'] === 'number', 'durationMs is a number');
    assert.deepEqual(completedEvent?.payload['prs'], ['PR-1']);
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

test('budget: sprint pauses when task cost exceeds limit', async () => {
  const paused: Array<{ sprintId: string; spentUsd: number; limitUsd: number }> = [];
  const adapter = new MockAdapter({ exitCode: 0, pr: 'PR-1', totalCostUsd: 3.00 });
  const h = makeManager({
    adapter,
    budgetUsd: 2.00,
    onBudgetPaused: (sprintId, spentUsd, limitUsd) => { paused.push({ sprintId, spentUsd, limitUsd }); },
  });
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1'] });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const finalRec = h.env.store.loadSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'paused');
    if (finalRec?.state.kind === 'paused') {
      assert.match(finalRec.state.reason, /budget/);
    }
    assert.equal(paused.length, 1);
    assert.equal(paused[0]?.limitUsd, 2.00);
    assert.equal(paused[0]?.spentUsd, 3.00);
    const budgetEvt = h.events.find((e) => e.kind === 'sprint.budget_paused');
    assert.ok(budgetEvt, 'expected sprint.budget_paused event');
  } finally {
    h.env.cleanup();
  }
});

test('budget: no pause when cost is below limit', async () => {
  const paused: string[] = [];
  const adapter = new MockAdapter({ exitCode: 0, pr: 'PR-1', totalCostUsd: 1.00 });
  const h = makeManager({
    adapter,
    budgetUsd: 5.00,
    onBudgetPaused: (sprintId) => { paused.push(sprintId); },
  });
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1'] });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const finalRec = h.env.store.loadSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'completed');
    assert.equal(paused.length, 0);
  } finally {
    h.env.cleanup();
  }
});

test('budget: paused sprint does not tick further', async () => {
  const adapter = new MockAdapter({ exitCode: 0, pr: 'PR-1', totalCostUsd: 3.00 });
  const h = makeManager({ adapter, budgetUsd: 2.00 });
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1', 't2'] });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    // After first task completes and budget is blown, second task should not be dispatched on next tick
    await h.manager.tick(rec.id);
    const spawnedCount = adapter.spawned.length;
    await h.manager.tick(rec.id); // extra tick — must not dispatch more
    assert.equal(adapter.spawned.length, spawnedCount);
  } finally {
    h.env.cleanup();
  }
});

test('budget: paused → running transition is valid', () => {
  assert.equal(canTransitionSprint('paused', 'running'), true);
  assert.equal(canTransitionSprint('paused', 'cancelled'), true);
  assert.equal(canTransitionSprint('running', 'paused'), true);
});

test('transition: sprint.completed payload includes durationMs', () => {
  let now = 1000;
  const clock = () => now;
  const h = makeManager({ now: clock });
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 't' });
    h.manager.transition(rec.id, { kind: 'running', startedAt: now });
    now = 3000;
    h.manager.transition(rec.id, { kind: 'completed', at: now, prs: [] });
    const completedEvt = h.events.find((e) => e.kind === 'sprint.completed');
    assert.ok(completedEvt, 'expected sprint.completed event');
    assert.equal(completedEvt?.payload.durationMs, 2000);
  } finally {
    h.env.cleanup();
  }
});

// Item 10: rate-limit pause
test('rate-limit: sprint pauses when all workers are rate-cap blocked', async () => {
  const now = 1000;
  const resetAt = 60_000;
  const ratePausedCalls: Array<{ sprintId: string; resetAt: number }> = [];
  const h = makeManager({
    now: () => now,
    onRatePaused: (sprintId, r) => { ratePausedCalls.push({ sprintId, resetAt: r }); },
  });
  try {
    // Drive worker w1 to high pressure (tokensRemaining=0 → pressure=1.0 > 0.85)
    h.pressure.recordHeaders('w1', {
      tokensRemaining: 0,
      tokensLimit: 1000,
      resetAt,
    });
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'rl-test',
      newTaskBriefs: ['brief-1'],
    });
    // First tick: sprint transitions queued→running but cannot dispatch (all blocked)
    await h.manager.tick(rec.id);
    const after = h.env.store.loadSprint(rec.id);
    assert.equal(after?.state.kind, 'paused', 'sprint should be paused when rate-capped');
    assert.equal(ratePausedCalls.length, 1, 'onRatePaused should be called once');
    assert.equal(ratePausedCalls[0]?.resetAt, resetAt);
  } finally {
    h.env.cleanup();
  }
});

test('awaitHandle: exitCode 2 → task cancelled, task.cancelled event emitted (not task.failed)', async () => {
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 2, error: 'user cancelled' }) });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const task = h.env.store.loadTask(rec.tasks[0]!);
    assert.equal(task?.state.kind, 'cancelled', 'task should be in cancelled state');
    if (task?.state.kind === 'cancelled') {
      assert.equal(task.state.reason, 'user cancelled');
    }
    const cancelledEvent = h.events.find((e) => e.kind === 'task.cancelled');
    assert.ok(cancelledEvent, 'expected task.cancelled event');
    const failedEvent = h.events.find((e) => e.kind === 'task.failed');
    assert.equal(failedEvent, undefined, 'task.failed must not be emitted');
  } finally {
    h.env.cleanup();
  }
});

test('awaitHandle: exitCode 3 → task failed, task.capability_blocked event emitted (not task.failed)', async () => {
  const h = makeManager({ adapter: new MockAdapter({ exitCode: 3, error: 'reviewer blocked' }) });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1'],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);
    const task = h.env.store.loadTask(rec.tasks[0]!);
    assert.equal(task?.state.kind, 'failed', 'task should be in failed state');
    if (task?.state.kind === 'failed') {
      assert.equal(task.state.error, 'reviewer blocked');
    }
    const blockedEvent = h.events.find((e) => e.kind === 'task.capability_blocked');
    assert.ok(blockedEvent, 'expected task.capability_blocked event');
    const failedEvent = h.events.find((e) => e.kind === 'task.failed');
    assert.equal(failedEvent, undefined, 'task.failed must not be emitted');
  } finally {
    h.env.cleanup();
  }
});

test('rate-limit: sprint auto-resumes when resetAt has passed', async () => {
  let now = 1000;
  const resetAt = 60_000;
  const h = makeManager({ now: () => now });
  try {
    h.pressure.recordHeaders('w1', {
      tokensRemaining: 0,
      tokensLimit: 1000,
      resetAt,
    });
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'rl-resume-test',
      newTaskBriefs: ['brief-1'],
    });
    // Tick at t=1000 → sprint should pause
    await h.manager.tick(rec.id);
    assert.equal(h.env.store.loadSprint(rec.id)?.state.kind, 'paused');

    // Advance time past resetAt — pressure will clear (resetAt <= now)
    now = resetAt + 1;

    // Tick at t=resetAt+1 → sprint should auto-resume and dispatch
    await h.manager.tick(rec.id);
    const after = h.env.store.loadSprint(rec.id);
    assert.equal(after?.state.kind, 'running', 'sprint should have resumed');
    assert.equal(h.adapter.spawned.length, 1, 'task should be dispatched after resume');

    // Drain the MockAdapter's setTimeout(0) resolver before closing the DB
    h.adapter.finishAll();
    await new Promise<void>((r) => setTimeout(r, 10));
    await h.manager.tick(rec.id);
  } finally {
    h.env.cleanup();
  }
});
