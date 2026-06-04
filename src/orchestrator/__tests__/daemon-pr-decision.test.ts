/**
 * Integration tests: wireSprintCompletion() → TaskStore PR-decision recording.
 *
 * Asserts the M4-T6 wiring (was M4-T5: the compute moved upstream to
 * wrapFactoryWithVerifierContext's teardown wrapper — see
 * daemon-verifier-wiring.test.ts for that path. This file tests the
 * read-side: the wiring reads the cached fingerprint that teardown stashed
 * on the registry and writes it on the pr_decisions row.):
 *   1. sprint.completed + PR URL + cached fingerprint → 'merged' row with
 *      mergedAt set and the cached 64-hex-char hash echoed back.
 *   2. sprint.failed + prior PR URL + cached fingerprint → 'rejected' row
 *      with the cached hash (verdict `'merged' | 'rejected'` taxonomy).
 *   3. sprint.failed without any PR URL → NO row written (graceful skip).
 *   4. sprint.cancelled + prior PR URL + cached fingerprint → 'rejected' row.
 *   5. sprint.completed + PR URL + cached fingerprint=NULL → row still
 *      inserted, fingerprint = NULL (failure-graceful contract: a teardown
 *      that failed to compute must not crash the sprint).
 *
 * The fingerprint is set via verifierCtx.setFingerprint(taskId, hex|null)
 * to mimic what wrapFactoryWithVerifierContext's teardown wrapper does
 * before removing the worktree. The wiring under test is sync — it just
 * reads the cache.
 *
 * Tests use a real tmp git repo for store + ctx scaffolding only; the
 * fingerprint compute itself is exercised in daemon-verifier-wiring.test.ts.
 *
 * No subprocess, Docker, Discord, or real Orchestrator. The Orchestrator is
 * replaced by a minimal in-process mock that exposes on/off/emit/getSprint.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { wireSprintCompletion, TaskContextRegistry } from '../daemon.js';
import { TaskStore } from '../../queue/store.js';
import type { OrchestratorEvent, SprintId } from '../types.js';
import type { QueuedTask } from '../../contracts/task.js';
import type { UnifiedQueueAdapter } from '../../queue/unified-adapter.js';
import type { Orchestrator } from '../index.js';

const execFileAsync = promisify(execFile);

// AUDIT-IFleet-43254bcf — strip every GIT_* env var inherited from the host
// process before spawning git. The pre-push hook inherits GIT_DIR /
// GIT_WORK_TREE / GIT_INDEX_FILE / etc. from `git push`; without scrubbing,
// the tmpdir's `git init` writes land in the host repo's `.git/config`
// (which is exactly how the parent repo's `core.bare` was flipped to `true`).
const cleanGitEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

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
// Fixture: tmp git repo + TaskStore
// ---------------------------------------------------------------------------

interface Fixture {
  store: TaskStore;
  repoRoot: string;
  cleanup: () => void;
}

/**
 * Builds a self-contained git repo with `main` and a feature branch that
 * adds one file. `git diff main..HEAD` produces a stable 1-file diff, so
 * computeStructuralFingerprint returns a deterministic non-empty hash.
 *
 * Sets `commit.gpgsign=false` + GIT_AUTHOR/COMMITTER env so the test
 * survives a host config that requires signed commits.
 */
async function makeFixture(): Promise<Fixture> {
  const workdir = mkdtempSync(join(tmpdir(), 'daemon-pr-decision-'));
  const store = new TaskStore(join(workdir, 'tasks.db'));
  const repoRoot = join(workdir, 'repo');

  // AUDIT-IFleet-43254bcf — isolate every git invocation from the host repo:
  //   - cleanGitEnv strips inherited GIT_* (incl. those set by the husky hook)
  //   - GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point at scratch paths so the
  //     test never touches ~/.gitconfig or /etc/gitconfig
  //   - GIT_DIR / GIT_WORK_TREE are NOT pre-set here because `git init <path>`
  //     creates the repo at <path>/.git and inherited values would clash;
  //     the explicit `cwd: repoRoot` on every subsequent call scopes resolution
  //     to the tmpdir.
  const gitEnv = {
    ...cleanGitEnv,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: join(workdir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const opts = { cwd: repoRoot, env: gitEnv };

  await execFileAsync('git', ['init', '-q', '-b', 'main', repoRoot], { env: gitEnv });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], opts);
  writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
  await execFileAsync('git', ['add', '.'], opts);
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], opts);

  await execFileAsync('git', ['checkout', '-q', '-b', 'feat/test'], opts);
  writeFileSync(join(repoRoot, 'new.txt'), 'hello\nworld\n');
  await execFileAsync('git', ['add', '.'], opts);
  await execFileAsync('git', ['commit', '-q', '-m', 'feat'], opts);

  // AUDIT-IFleet-25566c6a — defensive guard: after `git init`, assert the
  // tmpdir's .git/config has core.bare=false AND that resolution from the
  // tmpdir lands on the tmpdir's repo, not the parent. If either fails the
  // GIT_* scrub above leaked through and the test would contaminate the
  // host repo.
  const tmpToplevel = (
    await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], { env: gitEnv })
  ).stdout.trim();
  // macOS prepends `/private` to /var paths after symlink resolution; compare
  // realpaths so the guard fails on actual escape, not on cosmetic prefixes.
  const expected = realpathSync(repoRoot);
  const actual = realpathSync(tmpToplevel);
  assert.equal(
    actual,
    expected,
    `git resolution escaped tmpdir → ${actual} (expected ${expected}); GIT_* env leak suspected`,
  );

  return {
    store,
    repoRoot,
    cleanup: () => {
      store.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/**
 * Poll until the store has at least one pr_decisions row for the repo, or
 * timeoutMs elapses. The production wiring fires the fingerprint compute +
 * insert as a fire-and-forget Promise off the event handler so the test
 * thread needs a real wait — setImmediate alone is not enough because
 * `git diff --numstat` is a child_process call.
 */
async function pollForRows(
  store: TaskStore,
  repo: string,
  minCount: number,
  timeoutMs = 2000,
): Promise<ReturnType<TaskStore['getPrDecisionsByRepo']>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = store.getPrDecisionsByRepo(repo);
    if (rows.length >= minCount) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return store.getPrDecisionsByRepo(repo);
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Deterministic sentinel hex used to seed verifierCtx.setFingerprint(...) in
 * the wiring tests. The wiring should echo this exact value back onto the
 * pr_decisions row — proving the read-from-cache path, not the compute path.
 */
const CACHED_FP_HEX =
  'cafef00d000102030405060708090a0b0c0d0e0f10111213141516171819aabb';

// ---------------------------------------------------------------------------
// Regression guard: parent-repo .git state must be identical before/after this
// file runs. AUDIT-IFleet-43254bcf documents what happens when it isn't —
// every push from IFleet picks up 6 bogus "init" commits because the test's
// `git init` resolved to the parent .git via inherited GIT_DIR. The before/
// after snapshot makes any regression of the GIT_* scrub fail loudly here
// instead of silently in a future push.
// ---------------------------------------------------------------------------

const PARENT_REPO_ROOT = resolve('/Users/Seb/dev/ai-products/IFleet');

interface ParentSnapshot {
  log: string;
  bare: string;
  head: string;
}

function snapshotParentRepo(): ParentSnapshot | null {
  try {
    const log = execFileSync('git', ['-C', PARENT_REPO_ROOT, 'log', '--oneline', '-5'], {
      env: cleanGitEnv,
      encoding: 'utf8',
    });
    const bare = execFileSync('git', ['-C', PARENT_REPO_ROOT, 'config', '--get', 'core.bare'], {
      env: cleanGitEnv,
      encoding: 'utf8',
    });
    const head = execFileSync('git', ['-C', PARENT_REPO_ROOT, 'rev-parse', 'HEAD'], {
      env: cleanGitEnv,
      encoding: 'utf8',
    });
    return { log, bare, head };
  } catch {
    return null;
  }
}

let parentBefore: ParentSnapshot | null = null;

before(() => {
  parentBefore = snapshotParentRepo();
});

after(() => {
  if (parentBefore === null) return;
  const parentAfter = snapshotParentRepo();
  assert.ok(parentAfter, 'parent repo must still resolve after the test file runs');
  assert.equal(
    parentAfter.log,
    parentBefore.log,
    'parent .git log MUST NOT be mutated by this test file (AUDIT-IFleet-43254bcf regression)',
  );
  assert.equal(
    parentAfter.bare,
    parentBefore.bare,
    'parent .git/config core.bare MUST NOT be mutated by this test file (AUDIT-IFleet-25566c6a regression)',
  );
  assert.equal(
    parentAfter.head,
    parentBefore.head,
    'parent .git HEAD MUST NOT be mutated by this test file (AUDIT-IFleet-43254bcf regression)',
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('sprint.completed + PR URL + cached fingerprint → merged row with fingerprint', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask();
    const sprintId = 'sprint-pr-1' as SprintId;
    const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/42';
    const verifierCtx = new TaskContextRegistry();
    verifierCtx.record(task.id, {
      repoUrl: `https://github.com/${task.repo}`,
      branch: 'feat/test',
      worktreePath: fix.repoRoot,
    });
    // M4-T6: teardown would have cached the fingerprint here before sprint.completed fired.
    verifierCtx.setFingerprint(task.id, CACHED_FP_HEX);

    fix.store.insert(task);
    wireSprintCompletion(
      sprintId,
      task,
      adapter,
      orch as unknown as Orchestrator,
      fix.store,
      undefined,
      undefined,
      verifierCtx,
    );

    orch.emit({
      ts: 1,
      sprintId,
      taskId: task.id as import('../types.js').TaskId,
      kind: 'task.completed',
      payload: { pr: prUrl },
    });
    orch.emit({ ts: 2, sprintId, kind: 'sprint.completed', payload: {} });

    const rows = await pollForRows(fix.store, task.repo, 1);
    assert.equal(rows.length, 1, 'exactly one pr_decisions row');
    const row = rows[0]!;
    assert.equal(row.verdict, 'merged');
    assert.equal(row.prNumber, 42);
    assert.equal(row.repo, 'weautomatehq1/IFleet');
    assert.equal(row.taskId, task.id);
    assert.strictEqual(row.reviewerLogin, null);
    assert.ok(row.mergedAt !== null && row.mergedAt > 0, 'mergedAt set on merge');
    assert.match(row.fingerprint ?? '', FINGERPRINT_RE, 'fingerprint is 64-char hex');
    assert.equal(row.fingerprint, CACHED_FP_HEX, 'wiring echoes the cached hex verbatim');
  } finally {
    fix.cleanup();
  }
});

test('sprint.failed + prior PR URL + cached fingerprint → rejected row with fingerprint', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask({ id: 'task-pr-test-2', idempotencyKey: 'key-2' });
    const sprintId = 'sprint-pr-2' as SprintId;
    const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/77';
    const verifierCtx = new TaskContextRegistry();
    verifierCtx.record(task.id, {
      repoUrl: `https://github.com/${task.repo}`,
      branch: 'feat/test',
      worktreePath: fix.repoRoot,
    });
    verifierCtx.setFingerprint(task.id, CACHED_FP_HEX);

    fix.store.insert(task);
    wireSprintCompletion(
      sprintId,
      task,
      adapter,
      orch as unknown as Orchestrator,
      fix.store,
      undefined,
      undefined,
      verifierCtx,
    );

    orch.emit({
      ts: 1,
      sprintId,
      taskId: task.id as import('../types.js').TaskId,
      kind: 'task.completed',
      payload: { pr: prUrl },
    });
    orch.emit({ ts: 2, sprintId, kind: 'sprint.failed', payload: { from: 'running', to: 'failed' } });

    const rows = await pollForRows(fix.store, task.repo, 1);
    assert.equal(rows.length, 1, 'exactly one pr_decisions row');
    const row = rows[0]!;
    assert.equal(row.verdict, 'rejected');
    assert.equal(row.prNumber, 77);
    assert.equal(row.fingerprint, CACHED_FP_HEX, 'wiring echoes the cached hex verbatim');
  } finally {
    fix.cleanup();
  }
});

test('sprint.failed without any PR URL → no row written', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask({ id: 'task-pr-test-3', idempotencyKey: 'key-3' });
    const sprintId = 'sprint-pr-3' as SprintId;

    wireSprintCompletion(
      sprintId,
      task,
      adapter,
      orch as unknown as Orchestrator,
      fix.store,
    );

    orch.emit({ ts: 1, sprintId, kind: 'sprint.failed', payload: { from: 'running', to: 'failed' } });

    // Give the event loop a few ticks just in case some async path fired.
    await new Promise((r) => setTimeout(r, 50));
    const rows = fix.store.getPrDecisionsByRepo(task.repo);
    assert.equal(rows.length, 0, 'no row when no PR URL was captured');
  } finally {
    fix.cleanup();
  }
});

test('sprint.cancelled + prior PR URL + cached fingerprint → rejected row with fingerprint', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask({ id: 'task-pr-test-4', idempotencyKey: 'key-4' });
    const sprintId = 'sprint-pr-4' as SprintId;
    const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/99';
    const verifierCtx = new TaskContextRegistry();
    verifierCtx.record(task.id, {
      repoUrl: `https://github.com/${task.repo}`,
      branch: 'feat/test',
      worktreePath: fix.repoRoot,
    });
    verifierCtx.setFingerprint(task.id, CACHED_FP_HEX);

    fix.store.insert(task);
    wireSprintCompletion(
      sprintId,
      task,
      adapter,
      orch as unknown as Orchestrator,
      fix.store,
      undefined,
      undefined,
      verifierCtx,
    );

    orch.emit({
      ts: 1,
      sprintId,
      taskId: task.id as import('../types.js').TaskId,
      kind: 'task.completed',
      payload: { pr: prUrl },
    });
    orch.emit({ ts: 2, sprintId, kind: 'sprint.cancelled', payload: { from: 'running', to: 'cancelled' } });

    const rows = await pollForRows(fix.store, task.repo, 1);
    assert.equal(rows.length, 1, 'exactly one pr_decisions row');
    assert.equal(rows[0]!.verdict, 'rejected');
    assert.equal(rows[0]!.prNumber, 99);
    assert.equal(rows[0]!.fingerprint, CACHED_FP_HEX, 'wiring echoes the cached hex verbatim');
  } finally {
    fix.cleanup();
  }
});

test('sprint.completed + PR URL + cached fingerprint=null → row inserted with fingerprint=NULL', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask({ id: 'task-pr-test-5', idempotencyKey: 'key-5' });
    const sprintId = 'sprint-pr-5' as SprintId;
    const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/123';
    const verifierCtx = new TaskContextRegistry();
    verifierCtx.record(task.id, {
      repoUrl: `https://github.com/${task.repo}`,
      branch: 'feat/test',
      worktreePath: fix.repoRoot,
    });
    // M4-T6 graceful-failure contract: teardown attempted the compute and
    // failed (worktree gone before rev-parse, git error, malformed refs,
    // etc.), so the registry holds a recorded null. The wiring must still
    // insert the row — just with fingerprint=NULL — so PR-rejection
    // learning keeps the verdict signal even when the hash is missing.
    verifierCtx.setFingerprint(task.id, null);

    fix.store.insert(task);
    wireSprintCompletion(
      sprintId,
      task,
      adapter,
      orch as unknown as Orchestrator,
      fix.store,
      undefined,
      undefined,
      verifierCtx,
    );

    orch.emit({
      ts: 1,
      sprintId,
      taskId: task.id as import('../types.js').TaskId,
      kind: 'task.completed',
      payload: { pr: prUrl },
    });
    orch.emit({ ts: 2, sprintId, kind: 'sprint.completed', payload: {} });

    const rows = await pollForRows(fix.store, task.repo, 1);
    assert.equal(rows.length, 1, 'exactly one pr_decisions row even on cached null');
    const row = rows[0]!;
    assert.equal(row.verdict, 'merged');
    assert.equal(row.prNumber, 123);
    assert.strictEqual(row.fingerprint, null, 'fingerprint is NULL when cache holds null');
  } finally {
    fix.cleanup();
  }
});
