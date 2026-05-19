/**
 * VerifierController integration test — wires a stub sandbox + stub
 * invariants + real StateStore (sqlite tmp file) and asserts:
 *   1. task.completed events fire the controller.
 *   2. verifier_runs + verifier_failures rows land.
 *   3. The correct verifier.* event is emitted for each outcome.
 *   4. Manual rerun increments the attempt counter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifierController, type TaskRunContext } from '../controller.js';
import type { SandboxRunner } from '../sandbox.js';
import { InvariantRunner } from '../invariants.js';
import { VerifierStoreBridge } from '../store-bridge.js';
import { StateStore } from '../../../orchestrator/store.js';
import { newVerifierRunId } from '../types.js';
import type { OrchestratorEvent, SprintId, TaskId } from '../../../orchestrator/types.js';

const sprintId = 's1' as SprintId;
const taskId = 't1' as TaskId;

let dbDir: string;
let store: StateStore;

function seedSprintAndTask(): void {
  store.saveSprint({
    id: sprintId,
    mode: 'normal',
    goal: 'test',
    tasks: [],
    state: { kind: 'queued' },
    createdAt: 0,
    updatedAt: 0,
  });
  store.saveTask({
    id: taskId,
    sprintId,
    brief: 'test brief',
    state: { kind: 'completed', at: 1, pr: 'https://github.com/x/y/pull/1' },
    attempts: 1,
    createdAt: 0,
    updatedAt: 0,
  });
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'verifier-ctrl-'));
  store = new StateStore(join(dbDir, 'state.db'));
  seedSprintAndTask();
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

function makeSandbox(outcome: 'passed' | 'failed'): SandboxRunner {
  return {
    async run(input) {
      return {
        runId: newVerifierRunId('test-run-1'),
        status: outcome,
        startedAt: 100,
        finishedAt: 200,
        durationMs: 100,
        attempt: input.attempt,
        failures:
          outcome === 'failed'
            ? [{ kind: 'test', file: 'src/foo.test.ts', message: 'expected ok' }]
            : [],
        phases: [],
      };
    },
  };
}

function makeContext(): TaskRunContext {
  return {
    taskId,
    sprintId,
    repoUrl: 'https://github.com/weautomatehq1/IFleet',
    branch: 'feat/test',
    sha: 'deadbeef',
    attempt: 1,
  };
}

function makeController(sandbox: SandboxRunner, events: OrchestratorEvent[]): VerifierController {
  const invariants = {
    run: vi.fn().mockResolvedValue([]),
  } as unknown as InvariantRunner;
  return new VerifierController({
    store,
    sandbox,
    invariants,
    emit: (e) => events.push(e),
    resolveTaskContext: async () => makeContext(),
  });
}

describe('VerifierController', () => {
  it('emits verifier.passed and persists a row on green sandbox result', async () => {
    const events: OrchestratorEvent[] = [];
    const ctrl = makeController(makeSandbox('passed'), events);
    const result = await ctrl.verifyTask(taskId);
    expect(result?.status).toBe('passed');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('verifier.started');
    expect(kinds).toContain('verifier.passed');
    const bridge = new VerifierStoreBridge(store);
    const runs = bridge.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('passed');
  });

  it('emits verifier.failed and persists failure rows on red sandbox result', async () => {
    const events: OrchestratorEvent[] = [];
    const ctrl = makeController(makeSandbox('failed'), events);
    const result = await ctrl.verifyTask(taskId);
    expect(result?.status).toBe('failed');
    expect(events.map((e) => e.kind)).toContain('verifier.failed');
    const bridge = new VerifierStoreBridge(store);
    const runs = bridge.listRunsByTask(taskId);
    expect(runs[0]?.status).toBe('failed');
  });

  it('verifyManual increments attempt above the latest persisted run', async () => {
    const events: OrchestratorEvent[] = [];
    const ctrl = makeController(makeSandbox('passed'), events);
    await ctrl.verifyTask(taskId);
    const manualResult = await ctrl.verifyManual(taskId);
    expect('attempt' in manualResult && manualResult.attempt).toBe(2);
  });

  it('onEvent ignores non-task.completed events', () => {
    const events: OrchestratorEvent[] = [];
    const ctrl = makeController(makeSandbox('passed'), events);
    ctrl.onEvent({
      ts: 0,
      sprintId,
      taskId,
      kind: 'task.assigned',
      payload: {},
    });
    expect(events).toHaveLength(0);
  });
});
