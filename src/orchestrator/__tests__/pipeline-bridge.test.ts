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
  AttemptRecord,
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

test('decodeBridgeBrief converts a unified discord-sourced task into a legacy pipeline task', () => {
  const unified = {
    id: 'tk_disc',
    source: {
      kind: 'discord' as const,
      channelId: 'c1',
      messageId: 'm1',
      threadId: 't1',
      userId: 'u1',
      userLabel: 'seb',
    },
    repo: 'org/repo',
    brief: 'Fix the thing',
    title: 'Fix the thing',
    routingHints: { priority: 'normal' as const, verify: [], autonomy: 'review' as const },
    createdAt: 1,
    idempotencyKey: 'k1',
  };
  const decoded = decodeBridgeBrief(JSON.stringify({ kind: 'ifleet.pipeline.v1', task: unified }));
  assert.ok(decoded, 'decoded should be defined');
  assert.equal(decoded?.id, 'tk_disc');
  assert.equal(decoded?.issueNumber, 0, 'discord source carries no issue number');
  assert.equal(decoded?.body, 'Fix the thing');
  assert.equal(decoded?.repo, 'org/repo');
  assert.equal(decoded?.autonomy, 'review');
  assert.deepEqual(decoded?.labels, []);
});

test('decodeBridgeBrief converts a unified github-sourced task into a legacy pipeline task', () => {
  const unified = {
    id: 'tk_gh',
    source: {
      kind: 'github' as const,
      repo: 'org/repo',
      issueNumber: 99,
      issueNodeId: 'I_99',
      url: 'https://x/issues/99',
    },
    repo: 'org/repo',
    brief: 'Add greeting',
    title: 'Add greeting',
    routingHints: { priority: 'normal' as const, verify: [], autonomy: 'auto' as const },
    createdAt: 1,
    idempotencyKey: 'k99',
  };
  const decoded = decodeBridgeBrief(JSON.stringify({ kind: 'ifleet.pipeline.v1', task: unified }));
  assert.equal(decoded?.issueNumber, 99);
  assert.equal(decoded?.autonomy, 'auto');
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

// AUDIT-IFleet-25b947c4 / -9e154efd: totalCostUsd must flow through the bridge
// so SprintManager's BUDGET_USD cap can fire. mapPipelineResult previously
// copied totalTokens but never totalCostUsd, leaving sprint spend stuck at 0.

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    role: 'editor',
    workerId: 'w1',
    startedAt: 0,
    endedAt: 1,
    ok: true,
    output: '',
    rateLimitHits: 0,
    ...overrides,
  };
}

test('PipelineBridge sums per-attempt cost into SpawnResult.totalCostUsd', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'pr_opened',
      prUrl: 'https://x/1',
      attempts: [
        makeAttempt({ role: 'architect', totalCostUsd: 0.5 }),
        makeAttempt({ role: 'editor', totalCostUsd: 1.25 }),
        makeAttempt({ role: 'reviewer', totalCostUsd: 0.25 }),
      ],
    });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('cost-1'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.totalCostUsd, 2.0);
});

test('PipelineBridge leaves totalCostUsd undefined when no attempt reports cost', async () => {
  // Codex-style workers surface no USD; the mapped result must stay "unknown",
  // not coerce to 0 (which would let a free run advance budget by nothing while
  // masking that cost data was missing).
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'pr_opened',
      prUrl: 'https://x/1',
      attempts: [makeAttempt({ totalTokens: 1000 })],
    });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('cost-2'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.totalCostUsd, undefined);
});

test('PipelineBridge preserves a genuine zero cost (not collapsed to undefined)', async () => {
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'pr_opened',
      prUrl: 'https://x/1',
      attempts: [makeAttempt({ totalCostUsd: 0 })],
    });
  const bridge = new PipelineBridge(factory);
  const handle = await bridge.spawn(newTaskId('cost-3'), 'brief', {});
  const result = await handle.done;
  assert.equal(result.totalCostUsd, 0);
});

// Budget-cap behaviour: model SprintManager.accumulateCost over the mapped
// SpawnResult. Asserts the cap CANNOT trip when cost is omitted (the bug) and
// DOES trip once cost is wired through (the fix). Mirrors sprint.ts:436-450.
test('BUDGET_USD cap cannot fire when bridge omits cost, fires once wired', async () => {
  function accumulate(spend: number, costUsd: number | undefined): number {
    if (!costUsd) return spend; // mirrors SprintManager.accumulateCost
    return spend + costUsd;
  }
  const capUsd = 2.0;
  const capFires = (spend: number) => spend >= capUsd;

  // Bug repro: build a result whose attempts carry cost but pretend the bridge
  // never propagated it (the pre-fix behaviour). Cap can never trip.
  let spend = 0;
  for (let i = 0; i < 5; i++) {
    spend = accumulate(spend, undefined); // pre-fix: totalCostUsd undefined
  }
  assert.equal(capFires(spend), false, 'cap cannot fire while cost is omitted');

  // Fixed behaviour: the real bridge now carries totalCostUsd, so summing
  // across runs crosses the cap.
  const factory: PipelineRunnerFactory = async () =>
    makeBootstrap({
      status: 'pr_opened',
      prUrl: 'https://x/1',
      attempts: [makeAttempt({ totalCostUsd: 1.5 })],
    });
  const bridge = new PipelineBridge(factory);
  spend = 0;
  for (let i = 0; i < 2; i++) {
    const handle = await bridge.spawn(newTaskId('budget-' + i), 'brief', {});
    const mapped = await handle.done;
    spend = accumulate(spend, mapped.totalCostUsd);
  }
  assert.equal(spend, 3.0);
  assert.equal(capFires(spend), true, 'cap fires once cost is wired through');
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
