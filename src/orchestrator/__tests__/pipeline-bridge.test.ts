import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PipelineBridge,
  decodeBridgeBrief,
  encodeBridgeBrief,
  type PipelineRunBootstrap,
  type PipelineRunnerFactory,
} from '../pipeline-bridge';
import type {
  PipelineInput,
  PipelineResult,
  PipelineRunner,
  QueuedTask,
} from '../../pipeline/types';
import { newTaskId } from '../types';

function makeTask(): QueuedTask {
  return {
    id: 'task-1',
    issueNumber: 42,
    repo: 'weautomatehq1/IFleet',
    title: 'add greeting',
    body: 'Add a hello() function',
    autonomy: 'auto',
    labels: [],
  };
}

function makeBootstrap(
  result: PipelineResult,
  overrides: Partial<PipelineRunBootstrap> = {},
): PipelineRunBootstrap {
  const runner: PipelineRunner = { async run() { return result; } };
  const input = { task: makeTask() } as unknown as PipelineInput;
  return { runner, input, ...overrides };
}

test('encode/decode round-trips a QueuedTask', () => {
  const task = makeTask();
  const decoded = decodeBridgeBrief(encodeBridgeBrief(task));
  assert.deepEqual(decoded, task);
});

test('decodeBridgeBrief returns undefined for non-JSON brief', () => {
  assert.equal(decodeBridgeBrief('plain markdown brief'), undefined);
});

test('decodeBridgeBrief returns undefined for JSON without the bridge kind', () => {
  assert.equal(decodeBridgeBrief(JSON.stringify({ kind: 'other', task: {} })), undefined);
});

test('PipelineBridge maps pr_opened → exitCode 0 and propagates prUrl', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'pr_opened',
      prUrl: 'https://github.com/x/y/pull/1',
      attempts: [],
    });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t1'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.exitCode, 0);
  assert.equal(result.pr, 'https://github.com/x/y/pull/1');
  assert.equal(result.taskId, 't1');
});

test('PipelineBridge maps non-pr_opened → exitCode 1 with failureReason', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'failed',
      attempts: [],
      failureReason: 'editor failed',
    });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t2'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, 'editor failed');
  assert.equal(result.pr, undefined);
});

test('PipelineBridge maps blocked_by_reviewer to exitCode 3 with status as error', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({ status: 'blocked_by_reviewer', attempts: [] });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t3'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.exitCode, 3);
  assert.equal(result.error, 'blocked_by_reviewer');
});

test('PipelineBridge surfaces thrown errors as exitCode 1', async () => {
  const factory: PipelineRunnerFactory = async () => ({
    runner: { async run() { throw new Error('boom'); } },
    input: { task: makeTask() } as unknown as PipelineInput,
  });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t4'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, 'boom');
});

test('PipelineBridge.cancel aborts the controller and resolves done', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const factory: PipelineRunnerFactory = async () => ({
    runner: {
      async run(input) {
        observedSignal = input.abortSignal;
        await new Promise<void>((resolve) => {
          input.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'cancelled', attempts: [] };
      },
    },
    input: { task: makeTask(), abortSignal: controller.signal } as unknown as PipelineInput,
    abortController: controller,
  });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t5'), 'brief', {});
  await handle.cancel();
  const result = await handle.done;
  assert.equal(result.exitCode, 2);
  assert.equal(observedSignal?.aborted, true);
});

test('PipelineBridge runs teardown after successful run', async () => {
  let tornDown = false;
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap(
      { status: 'pr_opened', prUrl: 'https://x/1', attempts: [] },
      { teardown: () => { tornDown = true; } },
    );
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t6'), 'brief', {});
  await handle.done;
  assert.equal(tornDown, true);
});

// Item 7: distinct exit codes for all four pipeline statuses
test('PipelineBridge exit codes: pr_opened=0, failed=1, cancelled=2, blocked_by_reviewer=3', async () => {
  async function exitCodeFor(status: PipelineResult['status']): Promise<number> {
    const factory: PipelineRunnerFactory = async () =>
      makeBootstrap({ status, attempts: [] });
    const bridge = new PipelineBridge(factory);
    const handle = await bridge.spawn(newTaskId('ec-' + status), 'brief', {});
    return (await handle.done).exitCode;
  }
  assert.equal(await exitCodeFor('pr_opened'), 0);
  assert.equal(await exitCodeFor('failed'), 1);
  assert.equal(await exitCodeFor('cancelled'), 2);
  assert.equal(await exitCodeFor('blocked_by_reviewer'), 3);
});

// Item 5: decodeBridgeBrief rejects malformed QueuedTask payloads
test('decodeBridgeBrief returns undefined when task is missing required fields', () => {
  const bad = (task: unknown): string =>
    JSON.stringify({ kind: 'ifleet.pipeline.v1', task });
  assert.equal(decodeBridgeBrief(bad({})), undefined, 'empty task object');
  assert.equal(decodeBridgeBrief(bad({ id: 't', issueNumber: 1 })), undefined, 'partial task');
  assert.equal(
    decodeBridgeBrief(bad({ id: 't', issueNumber: 'not-a-number', repo: 'x/y', title: 't', body: 'b', autonomy: 'auto', labels: [] })),
    undefined,
    'issueNumber is string',
  );
  // valid task should decode successfully
  const valid = makeTask();
  assert.deepEqual(decodeBridgeBrief(JSON.stringify({ kind: 'ifleet.pipeline.v1', task: valid })), valid);
});

// Item 8: warn when abortController is absent from bootstrap
test('PipelineBridge warns when bootstrap has no abortController', async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    const factory: PipelineRunnerFactory = async () =>
      makeBootstrap({ status: 'pr_opened', prUrl: 'https://x/2', attempts: [] });
    const bridge = new PipelineBridge(factory);
    const handle = await bridge.spawn(newTaskId('t7'), 'brief', {});
    await handle.done;
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => w.includes('no abortController')), `expected abort warning, got: ${JSON.stringify(warnings)}`);
});
