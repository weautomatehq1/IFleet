/**
 * Daemon → VerifierController wiring test.
 *
 * Asserts that:
 *   1. wrapFactoryWithVerifierContext records repoUrl/branch/worktreePath at
 *      bootstrap and the post-edit HEAD SHA in its teardown wrapper.
 *   2. resolveVerifierContext returns a fully-populated TaskRunContext that
 *      VerifierController.onEvent will accept on a synthetic task.completed
 *      event, and the controller actually invokes the resolver.
 *
 * No subprocess, Docker, or Discord — just the in-process wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  TaskContextRegistry,
  resolveVerifierContext,
  wrapFactoryWithVerifierContext,
} from '../daemon';
import { encodeBridgeBrief } from '../pipeline-bridge';
import type { PipelineRunBootstrap, PipelineRunnerFactory } from '../pipeline-bridge';
import type { PipelineInput } from '../../pipeline/types';
import { StateStore } from '../store';
import {
  newSprintId,
  newTaskId,
  type OrchestratorEvent,
  type SprintId,
  type TaskId,
} from '../types';
import { VerifierController } from '../../agents/verifier/controller';
import { StubSandboxRunner } from '../../agents/verifier/sandbox';
import type { InvariantRunner } from '../../agents/verifier/invariants';

const execFileAsync = promisify(execFile);

// Strip git hook env vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …) before
// invoking git. The pre-push hook inherits these from `git push`, and they
// override the `-C <path>` flag's repo discovery — so `git config` writes land
// in the host repo's .git/config instead of the tmpdir.
const cleanGitEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { env: cleanGitEnv });
}

interface Fixture {
  store: StateStore;
  workdir: string;
  worktree: string;
  cleanup: () => void;
  sprintId: SprintId;
  taskId: TaskId;
}

async function makeFixture(): Promise<Fixture> {
  const workdir = mkdtempSync(join(tmpdir(), 'daemon-wiring-'));
  const worktree = join(workdir, 'wt');
  await git(['init', '-q', '-b', 'main', worktree]);
  await git(['-C', worktree, 'config', 'user.email', 'test@test']);
  await git(['-C', worktree, 'config', 'user.name', 'test']);
  await git(['-C', worktree, 'config', 'commit.gpgsign', 'false']);
  await git(['-C', worktree, 'commit', '--allow-empty', '-m', 'init']);
  const store = new StateStore(join(workdir, 'state.db'));
  const sprintId = newSprintId('sprint-1');
  const taskId = newTaskId('task-1');
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
    brief: 'irrelevant',
    state: { kind: 'completed', at: 1, pr: 'https://example/pr/1' },
    attempts: 1,
    createdAt: 0,
    updatedAt: 0,
  });
  return {
    store,
    workdir,
    worktree,
    sprintId,
    taskId,
    cleanup: () => {
      store.close();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

function makeInnerFactory(worktreePath: string): PipelineRunnerFactory {
  return async (): Promise<PipelineRunBootstrap> => ({
    runner: { async run() { return { status: 'pr_opened', attempts: [] }; } },
    input: { worktreePath } as PipelineInput,
  });
}

function makeBrief(taskId: TaskId): string {
  return encodeBridgeBrief({
    id: taskId,
    issueNumber: 99,
    repo: 'weautomatehq1/IFleet',
    title: 'feat: wire daemon to verifier',
    body: 'body',
    autonomy: 'auto',
    labels: [],
  });
}

// Stub invariant runner — controller calls `.run(opts)`, that's it.
const stubInvariants = { run: async (): Promise<[]> => [] } as unknown as InvariantRunner;

test('wrapFactoryWithVerifierContext records context + SHA; resolver returns it', async () => {
  const fx = await makeFixture();
  try {
    const registry = new TaskContextRegistry();
    const wrapped = wrapFactoryWithVerifierContext(makeInnerFactory(fx.worktree), registry);

    const bootstrap = await wrapped(fx.taskId, makeBrief(fx.taskId), {});
    // PipelineBridge invokes teardown in its finally block — that's where the
    // SHA must be captured before the worktree is removed in production.
    await bootstrap.teardown?.({ status: 'pr_opened', attempts: [] });

    const ctx = await resolveVerifierContext(fx.taskId, registry, fx.store);
    assert.ok(ctx, 'resolver should return a context after bootstrap+teardown');
    assert.equal(ctx.taskId, fx.taskId);
    assert.equal(ctx.sprintId, fx.sprintId);
    assert.equal(ctx.repoUrl, 'https://github.com/weautomatehq1/IFleet');
    assert.equal(ctx.worktreePath, fx.worktree);
    assert.match(ctx.branch, /^feat\/smoke-99-/);
    assert.match(ctx.sha, /^[0-9a-f]{40}$/);
    assert.equal(ctx.attempt, 1);
  } finally {
    fx.cleanup();
  }
});

test('VerifierController.onEvent fires the resolver on synthetic task.completed', async () => {
  const fx = await makeFixture();
  try {
    const registry = new TaskContextRegistry();
    const wrapped = wrapFactoryWithVerifierContext(makeInnerFactory(fx.worktree), registry);
    const bootstrap = await wrapped(fx.taskId, makeBrief(fx.taskId), {});
    await bootstrap.teardown?.({ status: 'pr_opened', attempts: [] });

    let resolverCalls = 0;
    let resolvedTaskId: TaskId | null = null;
    const controller = new VerifierController({
      store: fx.store,
      emit: () => {},
      sandbox: new StubSandboxRunner(),
      invariants: stubInvariants,
      resolveTaskContext: async (taskId) => {
        resolverCalls += 1;
        resolvedTaskId = taskId;
        return resolveVerifierContext(taskId, registry, fx.store);
      },
      invariantsRoot: fx.worktree,
    });

    const event: OrchestratorEvent = {
      ts: 0,
      sprintId: fx.sprintId,
      taskId: fx.taskId,
      kind: 'task.completed',
      payload: { pr: 'https://example/pr/1' },
    };
    controller.onEvent(event);
    // onEvent fires-and-forgets a microtask chain; let the async work settle.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    assert.equal(resolverCalls, 1);
    assert.equal(resolvedTaskId, fx.taskId);
  } finally {
    fx.cleanup();
  }
});

// AUDIT-IFleet-402694a7 — unit tests for TaskContextRegistry alias
// resolution. The class indexes records under the orchestrator's `tk_*`
// primary key and exposes them via an alias (unified queue ID — Discord
// ULID or GitHub node_id). Both namespaces must resolve the same record.
test('TaskContextRegistry: record(primary, rec, alias) → get(alias) returns the record', () => {
  const reg = new TaskContextRegistry();
  const rec = { repoUrl: 'https://github.com/x/y', branch: 'feat/a', worktreePath: '/tmp/wt' };
  reg.record('tk_primary', rec, 'alias_unified');
  assert.deepEqual(reg.get('alias_unified'), rec);
  assert.deepEqual(reg.get('tk_primary'), rec);
});

test('TaskContextRegistry: setSha(alias, sha) is stored on the primary record', () => {
  const reg = new TaskContextRegistry();
  reg.record(
    'tk_primary',
    { repoUrl: 'https://github.com/x/y', branch: 'feat/a', worktreePath: '/tmp/wt' },
    'alias_unified',
  );
  reg.setSha('alias_unified', 'deadbeef');
  assert.equal(reg.get('tk_primary')?.sha, 'deadbeef');
  assert.equal(reg.get('alias_unified')?.sha, 'deadbeef');
});

test('TaskContextRegistry: delete(alias) removes both primary and alias', () => {
  const reg = new TaskContextRegistry();
  reg.record(
    'tk_primary',
    { repoUrl: 'https://github.com/x/y', branch: 'feat/a', worktreePath: '/tmp/wt' },
    'alias_unified',
  );
  assert.equal(reg.size(), 1);
  assert.equal(reg.delete('alias_unified'), true);
  assert.equal(reg.size(), 0);
  assert.equal(reg.get('tk_primary'), undefined);
  assert.equal(reg.get('alias_unified'), undefined);
});

test('TaskContextRegistry: delete(primary) removes all aliases pointing at primary', () => {
  const reg = new TaskContextRegistry();
  const rec = { repoUrl: 'https://github.com/x/y', branch: 'feat/a', worktreePath: '/tmp/wt' };
  reg.record('tk_primary', rec, 'alias_unified');
  // A second record with its own alias — the primary delete should not
  // disturb unrelated aliases.
  reg.record('tk_other', { ...rec, branch: 'feat/b' }, 'alias_other');
  assert.equal(reg.delete('tk_primary'), true);
  assert.equal(reg.get('alias_unified'), undefined);
  assert.equal(reg.get('tk_primary'), undefined);
  // Unrelated entry survives.
  assert.equal(reg.get('alias_other')?.branch, 'feat/b');
  assert.equal(reg.size(), 1);
});

test('TaskContextRegistry: record without alias still resolves by primary', () => {
  const reg = new TaskContextRegistry();
  const rec = { repoUrl: 'https://github.com/x/y', branch: 'feat/a', worktreePath: '/tmp/wt' };
  reg.record('tk_primary', rec);
  assert.deepEqual(reg.get('tk_primary'), rec);
  reg.setSha('tk_primary', 'cafebabe');
  assert.equal(reg.get('tk_primary')?.sha, 'cafebabe');
  assert.equal(reg.delete('tk_primary'), true);
  assert.equal(reg.size(), 0);
});

test('onEvent ignores non-task.completed events', async () => {
  const fx = await makeFixture();
  try {
    let resolverCalls = 0;
    const controller = new VerifierController({
      store: fx.store,
      emit: () => {},
      sandbox: new StubSandboxRunner(),
      invariants: stubInvariants,
      resolveTaskContext: async () => {
        resolverCalls += 1;
        return null;
      },
    });
    controller.onEvent({
      ts: 0,
      sprintId: fx.sprintId,
      taskId: fx.taskId,
      kind: 'task.assigned',
      payload: {},
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(resolverCalls, 0);
  } finally {
    fx.cleanup();
  }
});
