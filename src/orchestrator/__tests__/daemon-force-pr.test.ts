/**
 * Unit tests for `handleForcePr` — AUDIT-IFleet-c9d0e1f2.
 *
 * Asserts the push-outcome gate around `octokit.rest.pulls.create`:
 *   1. push success            → pulls.create called
 *   2. "Everything up-to-date" → pulls.create called (benign push)
 *   3. push failure            → pulls.create NOT called, abort broadcast fires
 *   4. push failure            → handleForcePr resolves (does not throw)
 *   5. push failure broadcast contains the recovery copy
 *
 * No subprocess, no Docker, no real Discord/GitHub — execFile and broadcast
 * are injected as stubs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleForcePr, TaskContextRegistry } from '../daemon.js';
import type { ForcePrDeps } from '../daemon.js';
import { StateStore } from '../store.js';
import { TaskStore } from '../../queue/store.js';
import type { SprintId, TaskId } from '../types.js';

interface PullsCreateCall {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

interface Fixture {
  workdir: string;
  orchestratorStore: StateStore;
  store: TaskStore;
  verifierCtx: TaskContextRegistry;
  unifiedToSprintId: Map<string, SprintId>;
  taskId: string;
  sprintId: SprintId;
  branch: string;
  worktreePath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const workdir = mkdtempSync(join(tmpdir(), 'daemon-force-pr-'));
  const orchestratorStore = new StateStore(join(workdir, 'state.db'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  const verifierCtx = new TaskContextRegistry();
  const unifiedToSprintId = new Map<string, SprintId>();

  const taskId = 'task-force-pr-1';
  const sprintId = 'sprint-force-pr-1' as SprintId;
  const branch = 'feat/force-pr-test';
  const worktreePath = join(workdir, 'wt');

  verifierCtx.record(taskId, {
    repoUrl: 'https://github.com/weautomatehq1/IFleet',
    branch,
    worktreePath,
    sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });
  unifiedToSprintId.set(taskId, sprintId);

  return {
    workdir,
    orchestratorStore,
    store,
    verifierCtx,
    unifiedToSprintId,
    taskId,
    sprintId,
    branch,
    worktreePath,
    cleanup: () => {
      orchestratorStore.close();
      store.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

interface Stubs {
  execCalls: Array<{ args: ReadonlyArray<string>; cwd: string | undefined }>;
  pullsCreateCalls: PullsCreateCall[];
  broadcastCalls: string[];
}

function makeDeps(
  fx: Fixture,
  execImpl: (
    cmd: string,
    args: ReadonlyArray<string>,
    opts: { cwd?: string },
  ) => Promise<{ stdout: string; stderr: string }>,
): { deps: ForcePrDeps; stubs: Stubs } {
  const stubs: Stubs = {
    execCalls: [],
    pullsCreateCalls: [],
    broadcastCalls: [],
  };

  const execFile = (async (
    cmd: string,
    args: ReadonlyArray<string>,
    opts: { cwd?: string },
  ) => {
    stubs.execCalls.push({ args, cwd: opts.cwd });
    return execImpl(cmd, args, opts);
  }) as unknown as ForcePrDeps['execFile'];

  const octokit = {
    rest: {
      pulls: {
        create: async (params: PullsCreateCall) => {
          stubs.pullsCreateCalls.push(params);
          return { data: { number: 999, html_url: 'https://example/pr/999' } };
        },
      },
    },
  } as unknown as ForcePrDeps['octokit'];

  const broadcast = (msg: string): void => {
    stubs.broadcastCalls.push(msg);
  };

  const deps: ForcePrDeps = {
    store: fx.store,
    orchestratorStore: fx.orchestratorStore,
    unifiedToSprintId: fx.unifiedToSprintId,
    verifierCtx: fx.verifierCtx,
    octokit,
    execFile,
    broadcast,
  };
  return { deps, stubs };
}

test('handleForcePr — push success → pulls.create is called', async () => {
  const fx = makeFixture();
  try {
    const { deps, stubs } = makeDeps(fx, async () => ({ stdout: '', stderr: '' }));
    await handleForcePr(fx.taskId, 'operator override', deps);
    assert.equal(stubs.execCalls.length, 1, 'git push should run once');
    assert.deepEqual(stubs.execCalls[0]!.args, ['push', '-u', 'origin', fx.branch]);
    assert.equal(stubs.execCalls[0]!.cwd, fx.worktreePath);
    assert.equal(stubs.pullsCreateCalls.length, 1, 'pulls.create should be called once');
    assert.equal(stubs.pullsCreateCalls[0]!.owner, 'weautomatehq1');
    assert.equal(stubs.pullsCreateCalls[0]!.repo, 'IFleet');
    assert.equal(stubs.pullsCreateCalls[0]!.head, fx.branch);
    assert.equal(stubs.pullsCreateCalls[0]!.base, 'main');
    assert.equal(stubs.broadcastCalls.length, 0, 'success path should not broadcast');
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — push "Everything up-to-date" → pulls.create is still called', async () => {
  const fx = makeFixture();
  try {
    const { deps, stubs } = makeDeps(fx, async () => ({
      stdout: '',
      stderr: 'Everything up-to-date\n',
    }));
    await handleForcePr(fx.taskId, 'operator override', deps);
    assert.equal(stubs.execCalls.length, 1);
    assert.equal(
      stubs.pullsCreateCalls.length,
      1,
      'benign already-up-to-date should still proceed to pulls.create',
    );
    assert.equal(stubs.broadcastCalls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — push failure → pulls.create is NOT called, abort broadcast is emitted', async () => {
  const fx = makeFixture();
  try {
    const { deps, stubs } = makeDeps(fx, async () => {
      throw new Error('fatal: unable to access remote: connection refused');
    });
    await handleForcePr(fx.taskId, 'investigate broken verifier', deps);
    assert.equal(stubs.execCalls.length, 1);
    assert.equal(
      stubs.pullsCreateCalls.length,
      0,
      'push failure MUST NOT proceed to pulls.create',
    );
    assert.equal(stubs.broadcastCalls.length, 1, 'one abort broadcast should fire');
    assert.match(stubs.broadcastCalls[0]!, /ABORTED/);
    assert.match(stubs.broadcastCalls[0]!, /git push/);
    assert.match(stubs.broadcastCalls[0]!, /PR NOT opened/);
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — push failure does NOT throw (failure is handled, daemon continues)', async () => {
  const fx = makeFixture();
  try {
    const { deps } = makeDeps(fx, async () => {
      throw new Error('fatal: branch protection rejected push');
    });
    // assert.doesNotReject runs the promise and asserts it resolves.
    await assert.doesNotReject(handleForcePr(fx.taskId, 'override', deps));
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — push failure broadcast includes recovery guidance', async () => {
  const fx = makeFixture();
  try {
    const { deps, stubs } = makeDeps(fx, async () => {
      throw new Error('auth required');
    });
    await handleForcePr(fx.taskId, 'override', deps);
    assert.equal(stubs.broadcastCalls.length, 1);
    assert.match(stubs.broadcastCalls[0]!, /Recovery: investigate push failure/);
    assert.match(stubs.broadcastCalls[0]!, /auth/);
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — push failure appends verifier.force_pr_aborted audit event', async () => {
  const fx = makeFixture();
  try {
    const { deps } = makeDeps(fx, async () => {
      throw new Error('worktree gone');
    });
    await handleForcePr(fx.taskId, 'override', deps);
    const events = fx.orchestratorStore.loadEventsBySprint(fx.sprintId);
    const kinds = events.map((e) => e.kind);
    assert.ok(
      kinds.includes('verifier.force_pr'),
      'original verifier.force_pr audit row still appended',
    );
    assert.ok(
      kinds.includes('verifier.force_pr_aborted'),
      'verifier.force_pr_aborted audit row appended on push failure',
    );
    const aborted = events.find((e) => e.kind === 'verifier.force_pr_aborted')!;
    assert.equal(aborted.taskId, fx.taskId as TaskId);
    assert.equal((aborted.payload as { cause?: string }).cause, 'push_failed');
  } finally {
    fx.cleanup();
  }
});
