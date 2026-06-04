/**
 * Integration tests: wireSprintCompletion() → TaskStore PR-decision recording.
 *
 * Asserts the M4-T5 wiring:
 *   1. sprint.completed + PR URL + live worktree → 'merged' row with
 *      mergedAt set and a 64-hex-char structural fingerprint.
 *   2. sprint.failed + prior PR URL + live worktree → 'rejected' row with
 *      fingerprint (renamed from 'abandoned' in M4-T5 to match the
 *      pr_decisions verdict taxonomy: merged | rejected).
 *   3. sprint.failed without any PR URL → NO row written (graceful skip).
 *   4. sprint.cancelled + prior PR URL + live worktree → 'rejected' row.
 *   5. sprint.completed + PR URL + verifierCtx whose worktreePath does NOT
 *      exist → row still inserted, fingerprint = NULL (failure-graceful
 *      contract: a missing worktree must not crash the sprint).
 *
 * Tests use a real tmp git repo (not a mock) so the fingerprint compute
 * path exercises the actual `git diff --numstat` call.
 *
 * No subprocess, Docker, Discord, or real Orchestrator. The Orchestrator is
 * replaced by a minimal in-process mock that exposes on/off/emit/getSprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { wireSprintCompletion, TaskContextRegistry } from '../daemon.js';
import { TaskStore } from '../../queue/store.js';
import type { OrchestratorEvent, SprintId } from '../types.js';
import type { QueuedTask } from '../../contracts/task.js';
import type { UnifiedQueueAdapter } from '../../queue/unified-adapter.js';
import type { Orchestrator } from '../index.js';

const execFileAsync = promisify(execFile);

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

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const opts = { cwd: repoRoot, env: gitEnv };

  await execFileAsync('git', ['init', '-q', '-b', 'main', repoRoot]);
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], opts);
  writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
  await execFileAsync('git', ['add', '.'], opts);
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], opts);

  await execFileAsync('git', ['checkout', '-q', '-b', 'feat/test'], opts);
  writeFileSync(join(repoRoot, 'new.txt'), 'hello\nworld\n');
  await execFileAsync('git', ['add', '.'], opts);
  await execFileAsync('git', ['commit', '-q', '-m', 'feat'], opts);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('sprint.completed + PR URL + live worktree → merged row with fingerprint', async () => {
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
  } finally {
    fix.cleanup();
  }
});

test('sprint.failed + prior PR URL + live worktree → rejected row with fingerprint', async () => {
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
    assert.match(row.fingerprint ?? '', FINGERPRINT_RE, 'fingerprint is 64-char hex');
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

test('sprint.cancelled + prior PR URL + live worktree → rejected row with fingerprint', async () => {
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
    assert.match(rows[0]!.fingerprint ?? '', FINGERPRINT_RE);
  } finally {
    fix.cleanup();
  }
});

test('sprint.completed + PR URL + missing worktree → row inserted with fingerprint=NULL', async () => {
  const fix = await makeFixture();
  try {
    const orch = new MockOrchestrator();
    const adapter = makeAdapter();
    const task = makeTask({ id: 'task-pr-test-5', idempotencyKey: 'key-5' });
    const sprintId = 'sprint-pr-5' as SprintId;
    const prUrl = 'https://github.com/weautomatehq1/IFleet/pull/123';
    const verifierCtx = new TaskContextRegistry();
    // Point worktreePath at a directory that does NOT exist — git will fail
    // and the fingerprint compute path must swallow the error and insert
    // the row with fingerprint=NULL.
    verifierCtx.record(task.id, {
      repoUrl: `https://github.com/${task.repo}`,
      branch: 'feat/test',
      worktreePath: join(fix.repoRoot, 'does', 'not', 'exist'),
    });

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
    assert.equal(rows.length, 1, 'exactly one pr_decisions row even on compute failure');
    const row = rows[0]!;
    assert.equal(row.verdict, 'merged');
    assert.equal(row.prNumber, 123);
    assert.strictEqual(row.fingerprint, null, 'fingerprint is NULL on compute failure');
  } finally {
    fix.cleanup();
  }
});
