import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CLI_ADAPTER_NAME,
  createClaudeCliAdapter,
} from '../claude-cli.ts';
import {
  __resetAdapterRegistry,
  hasAdapter,
  registerAdapter,
  resolveAdapter,
} from '../registry.ts';
import { createFakeSpawn } from '../../__tests__/fake-spawn.ts';
import type { TaskId } from '../../../orchestrator/types.ts';

const SESSION_ID = 'sess-cli-001';

const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
});
const resultLine = JSON.stringify({
  type: 'result',
  result: 'done',
  total_cost_usd: 0.42,
});

interface ConfigFixture {
  configPath: string;
  cleanup: () => void;
}

function writeWorkersConfig(
  workers: Array<{
    id: string;
    provider?: string;
    authProfile?: string;
    models?: string[];
    enabled?: boolean;
    maxConcurrent?: number;
  }>,
): ConfigFixture {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-adapter-'));
  const configPath = join(dir, 'workers.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      workers: workers.map((w) => ({
        provider: 'claude',
        enabled: true,
        maxConcurrent: 1,
        ...w,
      })),
    }),
  );
  return {
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('claude-cli adapter: satisfies the orchestrator WorkerAdapter contract', () => {
  const adapter = createClaudeCliAdapter({
    inner: { spawnImpl: createFakeSpawn({ stdoutLines: [initLine, resultLine] }).spawn },
  });
  assert.equal(typeof adapter.spawn, 'function');
});

test('claude-cli adapter: spawn delegates to the inner Claude adapter and completes with exitCode=0', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const fixture = writeWorkersConfig([{ id: 'claude-max-1', models: ['claude-opus-4-7'] }]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    const handle = await adapter.spawn('t-1' as TaskId, 'do the thing', {});
    assert.equal(handle.taskId, 't-1');
    assert.equal(handle.workerId, 'claude-max-1');
    assert.equal(typeof handle.pid, 'number');

    const result = await handle.done;
    assert.equal(result.exitCode, 0);
    assert.equal(result.workerId, 'claude-max-1');
    assert.equal(result.totalCostUsd, 0.42);

    const call = fake.calls[0];
    assert.ok(call, 'inner adapter should have been spawned');
    assert.equal(call.command, 'claude');
    assert.ok(call.args.includes('-p'));
    // CRIT-1 fix: the brief is now wrapped in a delimited DATA block before
    // it is passed as the `-p` argument, so it is no longer present as a
    // literal arg — instead it appears *inside* the wrapped prompt string.
    const pIdx = call.args.indexOf('-p');
    const wrappedPrompt = call.args[pIdx + 1] ?? '';
    assert.ok(
      typeof wrappedPrompt === 'string' && wrappedPrompt.includes('do the thing'),
      'wrapped prompt should still contain the brief as data',
    );
    assert.ok(
      wrappedPrompt.includes('USER_BRIEF_BEGIN'),
      'wrapped prompt should include the data-block markers',
    );
    assert.ok(call.args.includes('--model'));
    assert.ok(call.args.includes('claude-opus-4-7'));
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: honors model override from SpawnOpts', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const fixture = writeWorkersConfig([{ id: 'claude-max-1', models: ['claude-opus-4-7'] }]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    const handle = await adapter.spawn('t-2' as TaskId, 'x', { model: 'claude-sonnet-4-6' });
    await handle.done;
    const call = fake.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes('claude-sonnet-4-6'));
    assert.ok(!call.args.includes('claude-opus-4-7'));
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: defaults to config models[0] when SpawnOpts.model omitted', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const fixture = writeWorkersConfig([
    { id: 'claude-max-1', models: ['claude-haiku-4-5', 'claude-opus-4-7'] },
  ]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    await (await adapter.spawn('t' as TaskId, 'x', {})).done;
    const call = fake.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes('claude-haiku-4-5'));
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: skips --profile flag for default authProfile', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const fixture = writeWorkersConfig([
    { id: 'claude-max-1', authProfile: 'default', models: ['claude-opus-4-7'] },
  ]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    await (await adapter.spawn('t' as TaskId, 'x', {})).done;
    const call = fake.calls[0];
    assert.ok(call);
    assert.ok(!call.args.includes('--profile'));
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: passes --profile when worker authProfile is non-default', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const fixture = writeWorkersConfig([
    { id: 'claude-max-1', authProfile: 'claude-max-2', models: ['claude-opus-4-7'] },
  ]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    await (await adapter.spawn('t' as TaskId, 'x', {})).done;
    const call = fake.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes('--profile'));
    assert.ok(call.args.includes('claude-max-2'));
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: falls back to default model when config is missing', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const adapter = createClaudeCliAdapter({
    configPath: join(tmpdir(), 'does-not-exist-claude-cli.json'),
    inner: { spawnImpl: fake.spawn },
  });
  await (await adapter.spawn('t' as TaskId, 'x', {})).done;
  const call = fake.calls[0];
  assert.ok(call);
  assert.ok(call.args.includes('claude-opus-4-7'));
});

test('claude-cli adapter: cancel() terminates the inner child', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [initLine],
    hangUntilSignal: true,
    killDelayMs: 1,
  });
  const fixture = writeWorkersConfig([{ id: 'claude-max-1', models: ['claude-opus-4-7'] }]);
  try {
    const adapter = createClaudeCliAdapter({
      configPath: fixture.configPath,
      inner: { spawnImpl: fake.spawn },
    });
    const handle = await adapter.spawn('t-cancel' as TaskId, 'hang', {});
    await handle.cancel();
    const result = await handle.done;
    // SIGTERM yields a non-zero exit through WorkerCrashError → error branch.
    assert.equal(result.exitCode, 1);
    assert.equal(result.workerId, 'claude-max-1');
    assert.equal(typeof result.error, 'string');
  } finally {
    fixture.cleanup();
  }
});

test('claude-cli adapter: self-registers on import under the canonical name', () => {
  __resetAdapterRegistry();
  // Verify self-registration uses the canonical adapter name by resetting and re-registering.
  registerAdapter(CLAUDE_CLI_ADAPTER_NAME, () => createClaudeCliAdapter());
  assert.ok(hasAdapter(CLAUDE_CLI_ADAPTER_NAME));
  const adapter = resolveAdapter(CLAUDE_CLI_ADAPTER_NAME);
  assert.equal(typeof adapter.spawn, 'function');
});

test('claude-cli adapter: LANGFUSE_PARENT_TRACE_ID injected from parentTraceId SpawnOpts', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const adapter = createClaudeCliAdapter({ inner: { spawnImpl: fake.spawn } });
  const handle = await adapter.spawn('t-trace-1' as TaskId, 'brief', { parentTraceId: 'sprint-trace-abc123' });
  await handle.done;
  const call = fake.calls[0];
  assert.ok(call, 'spawn was called');
  assert.equal(
    call.env?.['LANGFUSE_PARENT_TRACE_ID'],
    'sprint-trace-abc123',
    'child env should contain the sprint trace ID',
  );
});

test('claude-cli adapter: pre-existing LANGFUSE_PARENT_TRACE_ID in process.env is preserved over parentTraceId', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const adapter = createClaudeCliAdapter({ inner: { spawnImpl: fake.spawn } });
  const savedValue = process.env['LANGFUSE_PARENT_TRACE_ID'];
  process.env['LANGFUSE_PARENT_TRACE_ID'] = 'existing-debug-trace-id';
  try {
    const handle = await adapter.spawn('t-trace-2' as TaskId, 'brief', { parentTraceId: 'sprint-generated-id' });
    await handle.done;
    const call = fake.calls[0];
    assert.ok(call, 'spawn was called');
    assert.equal(
      call.env?.['LANGFUSE_PARENT_TRACE_ID'],
      'existing-debug-trace-id',
      'pre-existing env value should win over parentTraceId',
    );
  } finally {
    if (savedValue === undefined) {
      delete process.env['LANGFUSE_PARENT_TRACE_ID'];
    } else {
      process.env['LANGFUSE_PARENT_TRACE_ID'] = savedValue;
    }
  }
});
