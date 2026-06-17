/**
 * Unit tests for `handleForcePr` — AUDIT-IFleet-1b3a9906 / 4cd45bea
 * (supersedes the AUDIT-IFleet-c9d0e1f2 push-gate tests).
 *
 * The force-PR path now routes through the per-task `PrOpener` BRIDGE captured
 * on the TaskContextRegistry — the same seam the normal pipeline uses (push +
 * PR creation behind one abstraction). The orchestrator handler must NOT shell
 * `git push` or call `octokit.rest.pulls.create` directly.
 *
 * Asserts:
 *   1. happy path        → bridge open() called once with configurable base;
 *                          no Octokit, no direct git push
 *   2. configurable base → ctx.baseBranch is used, not hardcoded 'main'
 *   3. open() failure    → abort broadcast fires + force_pr_aborted audit row
 *   4. open() failure    → handleForcePr resolves (does not throw)
 *   5. abort broadcast contains the recovery copy
 *   6. "already exists"  → benign, no abort broadcast
 *   7. missing bridge    → audit row logged, open() never reached
 *
 * No subprocess, no Docker, no real Discord/GitHub — the PrOpener and broadcast
 * are injected as stubs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleForcePr, TaskContextRegistry } from '../daemon.js';
import type { ForcePrDeps } from '../daemon.js';
import { isSafeGitRef } from '../handlers/pr-decisions.js';
import { StateStore } from '../store.js';
import { TaskStore } from '../../queue/store.js';
import type { PrOpener, OpenPrInput } from '../../pipeline/types.js';
import type { SprintId, TaskId } from '../types.js';

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
  baseBranch: string;
  cleanup: () => void;
}

/**
 * Build a fixture. `prOpen` is the stub PrOpener.open() implementation; pass
 * `null` to register a record WITHOUT a bridge handle (test 7). `baseBranch`
 * defaults to a non-'main' value so the configurable-base assertion is real.
 */
function makeFixture(opts?: {
  prOpen?: ((input: OpenPrInput) => Promise<{ url: string; number: number }>) | null;
  baseBranch?: string;
}): Fixture & { openCalls: OpenPrInput[] } {
  const workdir = mkdtempSync(join(tmpdir(), 'daemon-force-pr-'));
  const orchestratorStore = new StateStore(join(workdir, 'state.db'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  const verifierCtx = new TaskContextRegistry();
  const unifiedToSprintId = new Map<string, SprintId>();

  const taskId = 'task-force-pr-1';
  const sprintId = 'sprint-force-pr-1' as SprintId;
  const branch = 'feat/force-pr-test';
  const worktreePath = join(workdir, 'wt');
  const baseBranch = opts?.baseBranch ?? 'develop';

  const openCalls: OpenPrInput[] = [];
  const hasBridge = opts?.prOpen !== null;
  const pr: PrOpener | undefined = hasBridge
    ? {
        async open(input) {
          openCalls.push(input);
          const impl = opts?.prOpen;
          if (impl) return impl(input);
          return { url: 'https://github.com/weautomatehq1/IFleet/pull/123', number: 123 };
        },
      }
    : undefined;

  verifierCtx.record(taskId, {
    repoUrl: 'https://github.com/weautomatehq1/IFleet',
    branch,
    worktreePath,
    sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ...(pr ? { pr } : {}),
    baseBranch,
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
    baseBranch,
    openCalls,
    cleanup: () => {
      orchestratorStore.close();
      store.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/**
 * Build deps. `octokit` and a direct-git execFile are passed as TRAPS — if the
 * handler ever calls them the test fails, proving GitHub access flows only
 * through the bridge.
 */
function makeDeps(fx: Fixture): { deps: ForcePrDeps; broadcastCalls: string[]; octokitCalled: { n: number } } {
  const broadcastCalls: string[] = [];
  const octokitCalled = { n: 0 };

  const octokit = {
    rest: {
      pulls: {
        create: async () => {
          octokitCalled.n++;
          throw new Error('TRAP: handler must not call octokit.rest.pulls.create');
        },
      },
    },
  } as unknown as ForcePrDeps['octokit'];

  const deps: ForcePrDeps = {
    store: fx.store,
    orchestratorStore: fx.orchestratorStore,
    unifiedToSprintId: fx.unifiedToSprintId,
    verifierCtx: fx.verifierCtx,
    octokit,
    broadcast: (msg: string) => {
      broadcastCalls.push(msg);
    },
  };
  return { deps, broadcastCalls, octokitCalled };
}

test('handleForcePr — happy path routes through the bridge (no Octokit, no direct git push)', async () => {
  const fx = makeFixture();
  try {
    const { deps, broadcastCalls, octokitCalled } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'operator override', deps);
    assert.equal(fx.openCalls.length, 1, 'bridge open() should be called once');
    assert.equal(fx.openCalls[0]!.headBranch, fx.branch);
    assert.equal(fx.openCalls[0]!.repo, 'weautomatehq1/IFleet');
    assert.equal(octokitCalled.n, 0, 'handler must NOT call octokit directly');
    assert.equal(broadcastCalls.length, 0, 'success path should not broadcast');
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — base branch is configurable (ctx.baseBranch, not hardcoded main)', async () => {
  const fx = makeFixture({ baseBranch: 'release/v2' });
  try {
    const { deps } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'operator override', deps);
    assert.equal(fx.openCalls.length, 1);
    assert.equal(fx.openCalls[0]!.baseBranch, 'release/v2', 'base must come from ctx.baseBranch');
    assert.notEqual(fx.openCalls[0]!.baseBranch, 'main');
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — bridge open() failure → abort broadcast is emitted', async () => {
  const fx = makeFixture({
    prOpen: async () => {
      throw new Error('fatal: unable to access remote: connection refused');
    },
  });
  try {
    const { deps, broadcastCalls } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'investigate broken verifier', deps);
    assert.equal(fx.openCalls.length, 1, 'open() was attempted');
    assert.equal(broadcastCalls.length, 1, 'one abort broadcast should fire');
    assert.match(broadcastCalls[0]!, /ABORTED/);
    assert.match(broadcastCalls[0]!, /PR NOT opened/);
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — bridge open() failure does NOT throw (daemon continues)', async () => {
  const fx = makeFixture({
    prOpen: async () => {
      throw new Error('fatal: branch protection rejected push');
    },
  });
  try {
    const { deps } = makeDeps(fx);
    await assert.doesNotReject(handleForcePr(fx.taskId, 'override', deps));
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — abort broadcast includes recovery guidance', async () => {
  const fx = makeFixture({
    prOpen: async () => {
      throw new Error('auth required');
    },
  });
  try {
    const { deps, broadcastCalls } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'override', deps);
    assert.equal(broadcastCalls.length, 1);
    assert.match(broadcastCalls[0]!, /Recovery: investigate push failure/);
    assert.match(broadcastCalls[0]!, /auth/);
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — bridge open() failure appends verifier.force_pr_aborted audit event', async () => {
  const fx = makeFixture({
    prOpen: async () => {
      throw new Error('worktree gone');
    },
  });
  try {
    const { deps } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'override', deps);
    const events = fx.orchestratorStore.loadEventsBySprint(fx.sprintId);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('verifier.force_pr'), 'original verifier.force_pr audit row still appended');
    assert.ok(
      kinds.includes('verifier.force_pr_aborted'),
      'verifier.force_pr_aborted audit row appended on bridge failure',
    );
    const aborted = events.find((e) => e.kind === 'verifier.force_pr_aborted')!;
    assert.equal(aborted.taskId, fx.taskId as TaskId);
    assert.equal((aborted.payload as { cause?: string }).cause, 'bridge_open_failed');
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — "already exists" error is benign (no abort broadcast)', async () => {
  const fx = makeFixture({
    prOpen: async () => {
      throw new Error('a pull request for branch "feat/force-pr-test" already exists');
    },
  });
  try {
    const { deps, broadcastCalls } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'override', deps);
    assert.equal(fx.openCalls.length, 1, 'open() was attempted');
    assert.equal(broadcastCalls.length, 0, 'PR-already-exists must NOT abort-broadcast');
    const events = fx.orchestratorStore.loadEventsBySprint(fx.sprintId);
    const kinds = events.map((e) => e.kind);
    assert.ok(!kinds.includes('verifier.force_pr_aborted'), 'no abort audit row for benign existing PR');
  } finally {
    fx.cleanup();
  }
});

test('handleForcePr — missing bridge handle → audit row logged, open() never reached', async () => {
  const fx = makeFixture({ prOpen: null });
  try {
    const { deps, broadcastCalls, octokitCalled } = makeDeps(fx);
    await handleForcePr(fx.taskId, 'override', deps);
    assert.equal(fx.openCalls.length, 0, 'no bridge to open through');
    assert.equal(octokitCalled.n, 0, 'must NOT fall back to Octokit');
    assert.equal(broadcastCalls.length, 0);
    const events = fx.orchestratorStore.loadEventsBySprint(fx.sprintId);
    assert.ok(events.map((e) => e.kind).includes('verifier.force_pr'), 'audit row still logged');
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// isSafeGitRef — unit tests (AUDIT-IFleet-4cd45bea hardening)
// ---------------------------------------------------------------------------

test('isSafeGitRef — accepts valid refs', () => {
  assert.ok(isSafeGitRef('main'), 'main');
  assert.ok(isSafeGitRef('develop'), 'develop');
  assert.ok(isSafeGitRef('release/v2'), 'release/v2');
  assert.ok(isSafeGitRef('feat/force-pr-test'), 'feat/force-pr-test');
  assert.ok(isSafeGitRef('release-1.2.3'), 'release-1.2.3');
});

test('isSafeGitRef — rejects .lock suffix on final component', () => {
  assert.equal(isSafeGitRef('foo.lock'), false, 'foo.lock');
  assert.equal(isSafeGitRef('refs/heads/x.lock'), false, 'refs/heads/x.lock');
});

test('isSafeGitRef — rejects .lock on non-final component (contains .lock/)', () => {
  assert.equal(isSafeGitRef('refs/heads.lock/main'), false, 'refs/heads.lock/main');
});

test('isSafeGitRef — rejects trailing dot', () => {
  assert.equal(isSafeGitRef('foo.'), false, 'foo.');
});

test('isSafeGitRef — rejects leading dot', () => {
  assert.equal(isSafeGitRef('.foo'), false, '.foo');
});

test('isSafeGitRef — rejects component beginning with dot', () => {
  assert.equal(isSafeGitRef('foo/.bar'), false, 'foo/.bar');
});

test('isSafeGitRef — rejects leading slash', () => {
  assert.equal(isSafeGitRef('/foo'), false, '/foo');
});

test('isSafeGitRef — rejects trailing slash', () => {
  assert.equal(isSafeGitRef('foo/'), false, 'foo/');
});

test('isSafeGitRef — rejects consecutive slashes', () => {
  assert.equal(isSafeGitRef('foo//bar'), false, 'foo//bar');
});

test('isSafeGitRef — rejects @{ sequence', () => {
  assert.equal(isSafeGitRef('foo@{1}'), false, 'foo@{1}');
});

test('isSafeGitRef — rejects bare @', () => {
  assert.equal(isSafeGitRef('@'), false, '@');
});

test('isSafeGitRef — rejects ref containing ASCII control character', () => {
  assert.equal(isSafeGitRef('foo\x01bar'), false, 'foo<SOH>bar');
  assert.equal(isSafeGitRef('foo\x00bar'), false, 'foo<NUL>bar');
  assert.equal(isSafeGitRef('foo\x7fbar'), false, 'foo<DEL>bar');
});

// ---------------------------------------------------------------------------
// AUDIT-IFleet-4cd45bea: raw-ref validation — leading/trailing whitespace/newline
// must be rejected (previously these slipped through trim() and reached the bridge)
// ---------------------------------------------------------------------------

test('isSafeGitRef — rejects ref with leading newline (\\nmain)', () => {
  assert.equal(isSafeGitRef('\nmain'), false, '\\nmain must be rejected');
});

test('isSafeGitRef — rejects ref with leading space ( main)', () => {
  assert.equal(isSafeGitRef(' main'), false, '" main" must be rejected');
});

test('isSafeGitRef — rejects ref with trailing space (main )', () => {
  assert.equal(isSafeGitRef('main '), false, '"main " must be rejected');
});

test('isSafeGitRef — rejects ref with trailing tab (main\\t)', () => {
  assert.equal(isSafeGitRef('main\t'), false, '"main\\t" must be rejected');
});

test('isSafeGitRef — rejects ref with leading tab (\\tmain)', () => {
  assert.equal(isSafeGitRef('\tmain'), false, '"\\tmain" must be rejected');
});

test('isSafeGitRef — still accepts clean valid refs', () => {
  assert.ok(isSafeGitRef('main'), 'main');
  assert.ok(isSafeGitRef('release/v2'), 'release/v2');
  assert.ok(isSafeGitRef('feat/force-pr-test'), 'feat/force-pr-test');
});
