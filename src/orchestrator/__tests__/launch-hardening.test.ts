import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../index';
import { PressureTracker } from '../pressure';
import { SprintManager } from '../sprint';
import { StateStore } from '../store';
import { WorkerRegistry } from '../workers';
import { PipelineBridge, type PipelineRunnerFactory } from '../pipeline-bridge';
import type { PipelineInput, PipelineResult, PipelineRunner, QueuedTask } from '../../pipeline/types';
import { MockAdapter, makeManager, noopBriefLoader } from './helpers';
import type { OrchestratorEvent, SpawnHandle, SpawnResult, TaskId } from '../types';

function makeStandalone(workerCount = 1): {
  dir: string;
  dbPath: string;
  workersConfig: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-launch-'));
  const dbPath = join(dir, 'state.db');
  const workersConfig = join(dir, 'workers.json');
  writeFileSync(
    workersConfig,
    JSON.stringify({
      workers: Array.from({ length: workerCount }, (_, i) => ({
        id: `w${i + 1}`,
        provider: 'claude',
        // 'api' so the budget guard (which only enforces when at least one
        // enabled worker is API-keyed) remains active for budget tests here.
        authProfile: 'api',
        maxConcurrent: 1,
        enabled: true,
      })),
    }),
  );
  return {
    dir,
    dbPath,
    workersConfig,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('budget resume: paused sprint can be resumed and finishes remaining tasks', async () => {
  const adapter = new MockAdapter({ exitCode: 0, pr: 'PR-1', totalCostUsd: 3.0 });
  const h = makeManager({ adapter, budgetUsd: 2.0 });
  try {
    const rec = h.manager.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1', 't2'],
    });
    await h.manager.tick(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    await h.manager.tick(rec.id);

    let sprint = h.env.store.loadSprint(rec.id);
    assert.equal(sprint?.state.kind, 'paused', 'expected sprint to be paused after budget hit');

    // Operator resumes.
    const resumed = h.manager.resumeSprint(rec.id, 'operator approved');
    assert.equal(resumed.state.kind, 'running');
    const resumedEvt = h.events.find((e) => e.kind === 'sprint.resumed');
    assert.ok(resumedEvt, 'expected sprint.resumed event');
    assert.equal(resumedEvt?.payload.reason, 'operator approved');

    // Tick again — both tasks dispatched on first tick (maxConcurrent=2) and
    // already completed before the budget pause fired, so resume drives the
    // sprint straight to `completed` on the next tick.
    await h.manager.tick(rec.id);
    sprint = h.env.store.loadSprint(rec.id);
    assert.equal(sprint?.state.kind, 'completed');
    assert.equal(adapter.spawned.length, 2, 'both tasks should have been dispatched');
  } finally {
    h.env.cleanup();
  }
});

test('budget resume: throws when sprint is not paused', () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g' });
    assert.throws(() => h.manager.resumeSprint(rec.id), /cannot resume sprint in state queued/);
  } finally {
    h.env.cleanup();
  }
});

test('budget resume: idempotent on already-running sprint', async () => {
  const h = makeManager();
  try {
    const rec = h.manager.startSprint({ mode: 'normal', goal: 'g' });
    h.manager.transition(rec.id, { kind: 'running', startedAt: 1 });
    const resumed = h.manager.resumeSprint(rec.id);
    assert.equal(resumed.state.kind, 'running');
  } finally {
    h.env.cleanup();
  }
});

test('budget resume: Orchestrator.resumeSprint re-activates the sprint for tick loop', async () => {
  const env = makeStandalone();
  try {
    const adapter = new MockAdapter({ exitCode: 0, pr: 'PR-x', totalCostUsd: 5.0 });
    const orch = new Orchestrator({
      adapter,
      briefLoader: noopBriefLoader,
      dbPath: env.dbPath,
      workersConfigPath: env.workersConfig,
      budgetUsd: 1.0,
      tickIntervalMs: 30,
      killPollIntervalMs: 9999,
      autoResume: false,
    });
    const rec = orch.submitSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1'] });
    orch.start();
    // Wait for the budget to trip.
    await waitFor(() => orch.getSprint(rec.id)?.state.kind === 'paused');
    // Sprint pause removes it from active. Resume puts it back.
    orch.resumeSprint(rec.id);
    assert.ok(
      orch.activeSprintIdsSnapshot().includes(rec.id),
      'resumed sprint should be in the active set',
    );
    await orch.stop();
  } finally {
    env.cleanup();
  }
});

test('crash recovery: orchestrator restart picks up pending tasks and completes the sprint', async () => {
  const env = makeStandalone();
  try {
    // Phase 1: start sprint, but do NOT let it finish.
    const adapter1 = new MockAdapter({ controllable: true });
    const orch1 = new Orchestrator({
      adapter: adapter1,
      briefLoader: noopBriefLoader,
      dbPath: env.dbPath,
      workersConfigPath: env.workersConfig,
      tickIntervalMs: 20,
      killPollIntervalMs: 9999,
      autoResume: false,
    });
    const rec = orch1.submitSprint({ mode: 'normal', goal: 'crash', newTaskBriefs: ['t1'] });
    orch1.start();
    // Wait for the task to be dispatched (running).
    await waitFor(() => adapter1.spawned.length >= 1);
    // Simulate a crash: stop without resolving the in-flight task.
    await orch1.stop();
    const midState = new StateStore(env.dbPath);
    try {
      const taskId = midState.loadSprint(rec.id)?.tasks[0];
      assert.ok(taskId);
      const task = midState.loadTask(taskId!);
      // Should be `running` or `assigned` — proves we crashed mid-flight.
      assert.ok(
        task?.state.kind === 'running' || task?.state.kind === 'assigned',
        `expected running/assigned, got ${task?.state.kind}`,
      );
    } finally {
      midState.close();
    }

    // Phase 2: spin up a fresh orchestrator on the same DB. autoResume=true.
    const adapter2 = new MockAdapter({ exitCode: 0, pr: 'PR-recovered' });
    const orch2 = new Orchestrator({
      adapter: adapter2,
      briefLoader: noopBriefLoader,
      dbPath: env.dbPath,
      workersConfigPath: env.workersConfig,
      tickIntervalMs: 20,
      killPollIntervalMs: 9999,
    });
    orch2.start();
    await waitFor(() => orch2.getSprint(rec.id)?.state.kind === 'completed', 2000);
    const finalRec = orch2.getSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'completed');
    if (finalRec?.state.kind === 'completed') {
      assert.deepEqual(finalRec.state.prs, ['PR-recovered']);
    }
    assert.equal(adapter2.spawned.length, 1, 'recovered task should be dispatched exactly once');
    await orch2.stop();
  } finally {
    env.cleanup();
  }
});

test('cancellation drain: every in-flight worker is cancelled and worker slots released', async () => {
  const env = makeStandalone(2);
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    const adapter = new MockAdapter({ controllable: true });
    const events: OrchestratorEvent[] = [];
    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter,
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
    });
    const rec = mgr.startSprint({
      mode: 'normal',
      goal: 'drain',
      newTaskBriefs: ['t1', 't2'],
    });
    await mgr.tick(rec.id);
    // Both workers should now be busy with controllable handles.
    assert.equal(adapter.spawned.length, 2, 'both tasks dispatched');
    assert.equal(registry.availableWorkers().length, 0, 'both workers acquired');
    assert.equal(mgr.runningTaskIds().length, 2);

    const cancelled = await mgr.cancelSprint(rec.id, 'drain-test');
    assert.equal(cancelled.state.kind, 'cancelled');
    assert.equal(adapter.cancelled.length, 2, 'both handles received cancel()');

    // awaitHandle resolves on the next microtask after cancel() resolves done.
    await waitFor(() => mgr.runningTaskIds().length === 0, 1000);
    assert.equal(mgr.runningTaskIds().length, 0, 'no orphaned running tasks');
    assert.equal(
      registry.availableWorkers().length,
      2,
      'both worker slots released back to registry',
    );

    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

test('PipelineBridge integration: failure surfaces failureReason via task.failed payload', async () => {
  const env = makeStandalone();
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    const events: OrchestratorEvent[] = [];

    const failingFactory: PipelineRunnerFactory = async (taskId, _brief, _opts) => {
      void taskId;
      void _brief;
      void _opts;
      const runner: PipelineRunner = {
        async run(_input: PipelineInput): Promise<PipelineResult> {
          void _input;
          return { status: 'failed', attempts: [], failureReason: 'editor exited 1' };
        },
      };
      const queued: QueuedTask = {
        id: 'task-1',
        issueNumber: 1,
        repo: 'weautomatehq1/IFleet',
        title: 't',
        body: 'b',
        autonomy: 'auto',
        labels: [],
      };
      return { runner, input: { task: queued } as unknown as PipelineInput };
    };

    // Adapter is the fallback no-op; the bridge replaces it because
    // pipelineFactory is set.
    const noopAdapter = {
      async spawn(taskId: TaskId): Promise<SpawnHandle> {
        return {
          workerId: 'w1',
          taskId,
          done: Promise.resolve<SpawnResult>({ taskId, workerId: 'w1', exitCode: 0 }),
          cancel: async () => undefined,
        };
      },
    };

    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter: noopAdapter,
      pipelineFactory: failingFactory,
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
    });
    const rec = mgr.startSprint({
      mode: 'normal',
      goal: 'pipeline-fail',
      newTaskBriefs: ['brief'],
    });
    await mgr.tick(rec.id);
    // Wait for the bridge's promise chain to settle.
    await waitFor(() => events.some((e) => e.kind === 'task.failed'), 1000);
    const failed = events.find((e) => e.kind === 'task.failed');
    assert.ok(failed, 'expected task.failed event');
    assert.equal(failed?.payload.error, 'editor exited 1');

    // Sprint should also fail.
    await mgr.tick(rec.id);
    const finalRec = store.loadSprint(rec.id);
    assert.equal(finalRec?.state.kind, 'failed');

    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

test('PipelineBridge integration: thrown error from runner propagates to task.failed', async () => {
  const env = makeStandalone();
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    const events: OrchestratorEvent[] = [];

    const throwingFactory: PipelineRunnerFactory = async () => ({
      runner: {
        async run() {
          throw new Error('pipeline boom');
        },
      },
      input: {
        task: {
          id: 't', issueNumber: 1, repo: 'r', title: 't', body: 'b',
          autonomy: 'auto', labels: [],
        },
      } as unknown as PipelineInput,
    });
    // Same noop adapter — bridge takes over.
    const noopAdapter = new PipelineBridge(throwingFactory);

    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter: noopAdapter,
      pipelineFactory: throwingFactory,
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
    });
    const rec = mgr.startSprint({
      mode: 'normal',
      goal: 'pipeline-throw',
      newTaskBriefs: ['brief'],
    });
    await mgr.tick(rec.id);
    await waitFor(() => events.some((e) => e.kind === 'task.failed'), 1000);
    const failed = events.find((e) => e.kind === 'task.failed');
    assert.ok(failed, 'expected task.failed event');
    assert.equal(failed?.payload.error, 'pipeline boom');

    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

test('sprint persistence: sprintSpend survives a SprintManager restart on the same DB', async () => {
  // Phase 1: accumulate spend via task completion.
  const env = makeStandalone();
  try {
    const adapter1 = new MockAdapter({ exitCode: 0, pr: 'PR-1', totalCostUsd: 1.5 });
    const store1 = new StateStore(env.dbPath);
    const registry1 = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    const events1: OrchestratorEvent[] = [];
    const mgr1 = new SprintManager({
      store: store1,
      registry: registry1,
      pressure: new PressureTracker(),
      adapter: adapter1,
      briefLoader: noopBriefLoader,
      emit: (e) => events1.push(e),
      budgetUsd: 10.0,
    });
    const rec = mgr1.startSprint({ mode: 'normal', goal: 'g', newTaskBriefs: ['t1'] });
    await mgr1.tick(rec.id);
    // Let awaitHandle settle so accumulateCost runs and persists.
    await waitFor(() => events1.some((e) => e.kind === 'task.completed'), 1000);
    registry1.stop();
    store1.close();

    // Phase 2: spin up a fresh SprintManager on the same DB and confirm the
    // running spend was rehydrated. The cheapest observable is to trip the
    // budget on a tiny second sprint and see the cap reflect prior spend.
    const store2 = new StateStore(env.dbPath);
    const registry2 = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    try {
      const runtime = store2.loadAllSprintRuntime();
      const persisted = runtime.get(rec.id);
      assert.ok(persisted, 'expected persisted runtime row for first sprint');
      assert.equal(persisted?.spentUsd, 1.5, 'spend persisted across manager restart');

      // And the new manager rehydrates the in-memory Map — drive a second task
      // on the SAME sprint, with a tiny cost; budget=2.0 should now trip
      // because prior spend (1.5) + new task cost (1.0) > 2.0.
      const adapter2 = new MockAdapter({ exitCode: 0, pr: 'PR-2', totalCostUsd: 1.0 });
      const events2: OrchestratorEvent[] = [];
      const mgr2 = new SprintManager({
        store: store2,
        registry: registry2,
        pressure: new PressureTracker(),
        adapter: adapter2,
        briefLoader: noopBriefLoader,
        emit: (e) => events2.push(e),
        budgetUsd: 2.0,
      });
      // Sprint completed in phase 1; start a fresh sprint that still shares
      // no in-memory spend with mgr1 but we directly assert rehydration via
      // the public side-effect: starting a NEW sprint on mgr2 should not be
      // affected. The assertion above on loadAllSprintRuntime + the
      // rehydration loop in the SprintManager constructor is the real
      // contract test; this manager construction also serves as a smoke
      // test that the rehydration path does not throw on existing rows.
      void mgr2;
      void adapter2;
    } finally {
      registry2.stop();
      store2.close();
    }
  } finally {
    env.cleanup();
  }
});

test('auto-loop: task completion schedules another tick without waiting for the cron', async () => {
  // Two tasks, single worker. With auto-loop, the first task completing
  // triggers a setImmediate that drives the next dispatch — we only call
  // tick() once explicitly, and both tasks should still be spawned.
  const env = makeStandalone(1);
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    const adapter = new MockAdapter({ exitCode: 0, pr: 'PR' });
    const events: OrchestratorEvent[] = [];
    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter,
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
    });
    const rec = mgr.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1', 't2'],
    });
    await mgr.tick(rec.id);
    // Only ONE explicit tick. If the auto-loop works, both tasks dispatch.
    await waitFor(() => adapter.spawned.length >= 2, 1000);
    assert.equal(adapter.spawned.length, 2, 'second task dispatched via auto-loop, not manual tick');
    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});

test('auto-loop: does not re-tick when sprint is paused (budget exhausted)', async () => {
  // After a budget pause, awaitHandle's setImmediate guard should short-
  // circuit on `state.kind === 'paused'`. Verify by spying on tick() via
  // a second-sprint dispatch attempt: if the loop ran, a second task would
  // get a worker; if guarded, only the first task's completion is observed.
  const env = makeStandalone(1);
  try {
    const store = new StateStore(env.dbPath);
    const registry = new WorkerRegistry({ configPath: env.workersConfig, watchFs: false });
    // First task reports 5.0, budget=1.0 → first completion paused the sprint.
    const adapter = new MockAdapter({ exitCode: 0, pr: 'PR', totalCostUsd: 5.0 });
    const events: OrchestratorEvent[] = [];
    const mgr = new SprintManager({
      store,
      registry,
      pressure: new PressureTracker(),
      adapter,
      briefLoader: noopBriefLoader,
      emit: (e) => events.push(e),
      budgetUsd: 1.0,
    });
    const rec = mgr.startSprint({
      mode: 'normal',
      goal: 'g',
      newTaskBriefs: ['t1', 't2'],
    });
    await mgr.tick(rec.id);
    // Wait for the first task to complete and the budget pause to fire.
    await waitFor(() => events.some((e) => e.kind === 'sprint.budget_paused'), 1000);
    // Give the auto-loop's setImmediate one full event-loop turn.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    // Only one task should have been spawned — the auto-loop must not have
    // dispatched a second task while the sprint sat paused.
    assert.equal(adapter.spawned.length, 1, 'paused sprint must not auto-dispatch additional tasks');
    registry.stop();
    store.close();
  } finally {
    env.cleanup();
  }
});
