/**
 * AUDIT-IFleet-3db72bd3 / 7b13a148 — deliberate /cancel and /stop must NOT be
 * recorded as 'failed'.
 *
 * Before this fix, both onCancel and onStop called
 * `store.updateState(id, 'failed', …)`, so an intentional operator stop was
 * indistinguishable from a pipeline crash — it polluted failure metrics and
 * risked tripping failure-driven retry/backoff.
 *
 * The TaskState enum (src/contracts/task.ts) has no 'cancelled' member and that
 * contract is owned by another lane, so the fix records the existing
 * terminal-ish 'blocked' state with `stateMeta.cancelled === true` instead.
 *
 * These tests use a REAL in-memory TaskStore (so the recorded state is observed
 * through the actual store, not a spy) and stub the rest of the control-plane
 * deps. They assert:
 *   1. onCancel records 'blocked' (+ cancelled:true), never 'failed'
 *   2. onStop   records 'blocked' (+ cancelled:true), never 'failed'
 *   3. a 'blocked' cancel row is terminal — pickNext() never re-serves it
 *      (i.e. no failure-driven retry)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildControlPlaneOptions } from '../control-plane.js';
import type { ControlPlaneDeps } from '../control-plane.js';
import { TaskStore } from '../../../queue/store.js';
import type { QueuedTask } from '../../../contracts/task.js';
import type { SprintId } from '../../types.js';

function makeTask(id: string, state: QueuedTask['state']): QueuedTask {
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
    createdAt: 1_700_000_000_000,
    idempotencyKey: `idem_${id}`,
    ...(state ? { state } : {}),
  };
}

/**
 * Build control-plane callbacks over a real TaskStore. Only the deps that
 * onCancel/onStop actually touch are realised; the rest are stubs that throw if
 * unexpectedly invoked (none of these tests call the other callbacks).
 */
function makeOptions(opts: {
  store: TaskStore;
  runningSprintIds?: string[];
  unifiedToSprintId?: Map<string, SprintId>;
}) {
  const approvalResolves: Array<{ id: string; decision: string }> = [];
  const cancelSprintCalls: string[] = [];

  const approvalGate = {
    resolve: (id: string, decision: string) => {
      approvalResolves.push({ id, decision });
    },
  } as unknown as ControlPlaneDeps['approvalGate'];

  const orchestrator = {
    cancelSprint: async (id: string) => {
      cancelSprintCalls.push(id);
    },
  } as unknown as ControlPlaneDeps['orchestrator'];

  const orchestratorStore = {
    listSprintsByStateKind: (_kind: string) =>
      (opts.runningSprintIds ?? []).map((id) => ({ id })),
  } as unknown as ControlPlaneDeps['orchestratorStore'];

  const deps: ControlPlaneDeps = {
    store: opts.store,
    orchestratorStore,
    approvalGate,
    discordSource: undefined as unknown as ControlPlaneDeps['discordSource'],
    orchestrator,
    verifierController: undefined as unknown as ControlPlaneDeps['verifierController'],
    verifierCtx: undefined as unknown as ControlPlaneDeps['verifierCtx'],
    unifiedToSprintId: opts.unifiedToSprintId ?? new Map<string, SprintId>(),
    octokit: undefined as unknown as ControlPlaneDeps['octokit'],
  };

  return { options: buildControlPlaneOptions(deps), approvalResolves, cancelSprintCalls };
}

test('onCancel records the distinct cancel state, NOT failed', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cp-cancel-'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  try {
    const taskId = 'tk-cancel-1';
    store.insert(makeTask(taskId, 'in_flight'));

    const { options, approvalResolves } = makeOptions({ store });
    await options.onCancel!(taskId, 'operator changed their mind');

    const row = store.getById(taskId);
    assert.ok(row, 'task row exists after cancel');
    assert.notEqual(row!.state, 'failed', '/cancel must NOT record failed');
    assert.equal(row!.state, 'blocked', '/cancel records the distinct blocked state');
    assert.equal(
      row!.stateMeta?.['cancelled'],
      true,
      'cancelled:true marks a deliberate cancel apart from a capability block',
    );
    assert.equal(
      approvalResolves.find((r) => r.id === taskId)?.decision,
      'cancel',
      'approval gate still resolved with the cancel decision',
    );
  } finally {
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('onStop records the distinct cancel state for every running task, NOT failed', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cp-stop-'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  // setFleetPaused writes a pause flag under IFLEET_REPO_ROOT — keep it in the
  // temp sandbox so the test does not touch the real worktree.
  const prevRoot = process.env['IFLEET_REPO_ROOT'];
  process.env['IFLEET_REPO_ROOT'] = workdir;
  try {
    const unifiedId = 'tk-stop-1';
    const sprintId = 'sprint-stop-1' as SprintId;
    store.insert(makeTask(unifiedId, 'in_flight'));

    const unifiedToSprintId = new Map<string, SprintId>([[unifiedId, sprintId]]);
    const { options, cancelSprintCalls } = makeOptions({
      store,
      runningSprintIds: [sprintId],
      unifiedToSprintId,
    });

    await options.onStop!({ type: 'stop', reason: 'fleet stop drill', userLabel: 'operator' });

    const row = store.getById(unifiedId);
    assert.ok(row, 'task row exists after stop');
    assert.notEqual(row!.state, 'failed', '/stop must NOT record failed');
    assert.equal(row!.state, 'blocked', '/stop records the distinct blocked state');
    assert.equal(row!.stateMeta?.['cancelled'], true, 'cancelled:true marker is set on /stop');
    assert.ok(cancelSprintCalls.includes(sprintId), 'running sprint was actually aborted');
  } finally {
    if (prevRoot === undefined) delete process.env['IFLEET_REPO_ROOT'];
    else process.env['IFLEET_REPO_ROOT'] = prevRoot;
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('a cancelled (blocked) row is terminal — pickNext never re-serves it (no failure-driven retry)', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'cp-terminal-'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  try {
    const taskId = 'tk-terminal-1';
    store.insert(makeTask(taskId, 'in_flight'));

    const { options } = makeOptions({ store });
    await options.onCancel!(taskId, 'cancelled');

    assert.equal(store.getById(taskId)!.state, 'blocked');
    // pickNext only consumes 'pending' rows, so a deliberately-cancelled task
    // is never reclaimed as work — confirming cancel ≠ failure-driven retry.
    assert.equal(store.pickNext(), null, 'no pending work — blocked cancel row is not re-served');
  } finally {
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
