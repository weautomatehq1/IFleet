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

test('PipelineBridge maps blocked_by_reviewer to exitCode 1 with status as error', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({ status: 'blocked_by_reviewer', attempts: [] });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('t3'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.exitCode, 1);
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
  assert.equal(result.exitCode, 1);
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
