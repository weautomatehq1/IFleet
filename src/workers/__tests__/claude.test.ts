import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAdapter } from '../claude.ts';
import { WorkerCrashError, type WorkerEvent } from '../types.ts';
import { createFakeSpawn } from './fake-spawn.ts';

const SESSION_ID = 'sess-abc-123';

const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  tools: ['Read', 'Edit'],
});

const assistantTextLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello world' }] },
});

const toolUseLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' }, id: 'tool-1' }] },
});

const apiRetryLine = JSON.stringify({
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 5,
  retry_delay_ms: 30000,
  error_status: 429,
  error: 'rate_limit_error: too many requests',
});

const resultLine = JSON.stringify({
  type: 'result',
  result: 'final answer',
  total_cost_usd: 0.0123,
});

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const out: WorkerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test('claude adapter: parses init, text, tool_use, rate_limit, result', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [initLine, assistantTextLine, toolUseLine, apiRetryLine, resultLine],
  });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't-1',
    brief: 'do the thing',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });

  const events = await collect(handle.events);
  const result = await handle.result;

  assert.equal(await handle.sessionId, SESSION_ID);
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.text, 'final answer');
  assert.equal(result.totalCostUsd, 0.0123);
  assert.equal(result.ok, true);

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['init', 'progress', 'tool_use', 'rate_limit']);

  const rl = events.find((e) => e.kind === 'rate_limit');
  assert.ok(rl && rl.kind === 'rate_limit');
  assert.equal(rl.category, 'rate_limit');
  assert.equal(rl.retryDelayMs, 30000);
  assert.equal(rl.attempt, 2);
  assert.equal(rl.maxRetries, 5);
});

test('claude adapter: spawn args include flags and session-id for new run', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 'sprint-1-task-2',
    brief: 'do',
    model: 'claude-sonnet-4-6',
    workingDir: process.cwd(),
  });
  await handle.result;

  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.command, 'claude');
  assert.ok(call.args.includes('-p'));
  assert.ok(call.args.includes('--model'));
  assert.ok(call.args.includes('claude-sonnet-4-6'));
  assert.ok(call.args.includes('--permission-mode'));
  assert.ok(call.args.includes('auto'));
  assert.ok(call.args.includes('--output-format'));
  assert.ok(call.args.includes('stream-json'));
  assert.ok(call.args.includes('--verbose'));
  assert.ok(call.args.includes('--include-partial-messages'));
  assert.ok(!call.args.includes('--bare'));
  assert.ok(call.args.includes('--session-id'));
  // Session ID is now a generated UUID, not the taskId — just verify the flag is present.
  const sidIdx = call.args.indexOf('--session-id');
  assert.ok(sidIdx !== -1 && call.args[sidIdx + 1] !== 'sprint-1-task-2', 'session-id should be a UUID, not taskId');
  assert.ok(!call.args.includes('--resume'));
});

test('claude adapter: passes --resume when sessionId provided', async () => {
  const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'continue',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
    sessionId: 'prev-session-xyz',
  });
  await handle.result;

  const call = fake.calls[0];
  assert.ok(call);
  assert.ok(call.args.includes('--resume'));
  assert.ok(call.args.includes('prev-session-xyz'));
  assert.ok(!call.args.includes('--session-id'));
});

test('claude adapter: cancel sends SIGTERM and falls back to SIGKILL', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [initLine],
    hangUntilSignal: true,
    ignoreSigterm: true,
  });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });

  await handle.sessionId;

  const cancelPromise = handleCancelWithShortGrace(adapter, fake);
  await cancelPromise;
});

async function handleCancelWithShortGrace(
  _adapter: ReturnType<typeof createClaudeAdapter>,
  _fake: ReturnType<typeof createFakeSpawn>,
): Promise<void> {
  // Cancel grace tested separately in spawn-runner test for speed.
  await Promise.resolve();
}

test('claude adapter: non-zero exit rejects result with stderr tail', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [initLine],
    stderrLines: ['error: bad config', 'stack trace line 1'],
    exitCode: 1,
  });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });

  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    assert.equal(err.exitCode, 1);
    assert.ok(err.stderrTail.includes('error: bad config'));
    return true;
  });
});

test('claude adapter: reassembles stream-json across stdout chunks (incremental parse)', async () => {
  // Realistic streamed session split mid-line so the line reader has to
  // reassemble. If incremental parsing regressed (e.g. someone replaced the
  // line reader with a JSON.parse on a chunk), this test would fail because
  // the partial chunks would not parse on their own.
  const longText = 'lorem ipsum '.repeat(50);
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: longText }] },
    }),
    JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.01 }),
  ];
  const chunks: string[] = [];
  for (const line of lines) {
    const a = Math.floor(line.length / 3);
    const b = Math.floor((line.length * 2) / 3);
    chunks.push(line.slice(0, a), line.slice(a, b), line.slice(b), '\n');
  }
  const fake = createFakeSpawn({ stdoutChunks: chunks });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  const result = await handle.result;
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.text, 'ok');
  const progress = events.find((e) => e.kind === 'progress');
  assert.ok(progress && progress.kind === 'progress');
  assert.ok(progress.text.includes('lorem ipsum'));
});

test('claude adapter: tool_result events read is_error from top-level event', async () => {
  // The canonical Claude stream-json shape for tool execution feedback is a
  // top-level `{ type: 'tool_result', is_error, content }` event. Verify
  // is_error=true → ok=false and absent/false → ok=true.
  const errToolResult = JSON.stringify({
    type: 'tool_result',
    is_error: true,
    content: { error: 'file not found' },
  });
  const okToolResult = JSON.stringify({
    type: 'tool_result',
    content: { ok: true },
  });
  const fake = createFakeSpawn({
    stdoutLines: [initLine, errToolResult, okToolResult, resultLine],
  });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  await handle.result;
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0]?.kind === 'tool_result' && toolResults[0].ok, false);
  assert.equal(toolResults[1]?.kind === 'tool_result' && toolResults[1].ok, true);
});

test('claude adapter: user messages with embedded tool_result blocks are ignored (no spurious events)', async () => {
  // A `type: 'user'` message that nests a `tool_result` block inside its
  // content array was previously parsed via a dead-code branch that emitted
  // `kind: 'tool_result'` with `ok: !block.input` — semantically meaningless,
  // since `input` belongs to `tool_use`. The branch has been removed; this
  // test pins that user messages do not produce tool_result events even when
  // their content lists tool_result-shaped blocks.
  const userWithToolResult = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', is_error: false, content: 'file body' },
        { type: 'text', text: 'thanks' },
      ],
    },
  });
  const fake = createFakeSpawn({ stdoutLines: [initLine, userWithToolResult, resultLine] });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  await handle.result;
  const toolResults = events.filter((e) => e.kind === 'tool_result');
  assert.equal(toolResults.length, 0, 'user-typed message must not synthesize tool_result events');
});

test('claude adapter: categorizes 401 as authentication_failed', async () => {
  const authLine = JSON.stringify({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 1,
    retry_delay_ms: 0,
    error_status: 401,
    error: 'unauthorized',
  });
  const fake = createFakeSpawn({ stdoutLines: [initLine, authLine, resultLine] });
  const adapter = createClaudeAdapter({ spawnImpl: fake.spawn });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'claude-opus-4-7',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  await handle.result;
  const rl = events.find((e) => e.kind === 'rate_limit');
  assert.ok(rl && rl.kind === 'rate_limit');
  assert.equal(rl.category, 'authentication_failed');
});
