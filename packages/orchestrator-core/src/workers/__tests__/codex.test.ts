import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexChildEnv, createCodexAdapter } from '../codex.ts';
import { WorkerCrashError, type WorkerEvent } from '../types.ts';
import { createFakeSpawn } from './fake-spawn.ts';

const THREAD_ID = 'codex-thread-xyz';

const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID });
const turnStarted = JSON.stringify({ type: 'turn.started', turn_id: 't-1' });
const toolCreated = JSON.stringify({
  type: 'item.created',
  item: { type: 'tool_call', name: 'apply_patch', arguments: { path: 'a.ts' } },
});
const toolCompleted = JSON.stringify({
  type: 'item.completed',
  item: { type: 'tool_call', name: 'apply_patch', success: true, output: 'ok' },
});
const assistantCompleted = JSON.stringify({
  type: 'item.completed',
  item: { type: 'assistant_message', text: 'done.' },
});
const turnCompleted = JSON.stringify({ type: 'turn.completed', turn_id: 't-1' });
const rateLimitError = JSON.stringify({
  type: 'error',
  error: { message: 'rate limit exceeded', status: 429 },
});

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const out: WorkerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test('codex adapter: parses thread.started, items, and emits clean events', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [threadStarted, turnStarted, toolCreated, toolCompleted, assistantCompleted, turnCompleted],
  });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't-codex-1',
    brief: 'do',
    model: 'codex',
    workingDir: process.cwd(),
  });

  const events = await collect(handle.events);
  const result = await handle.result;

  assert.equal(await handle.sessionId, THREAD_ID);
  assert.equal(result.sessionId, THREAD_ID);
  assert.ok(result.text.includes('done'));

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['init', 'tool_use', 'tool_result', 'progress']);

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: rate-limit error becomes rate_limit event', async () => {
  const fake = createFakeSpawn({ stdoutLines: [threadStarted, rateLimitError] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'codex',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  await handle.result;
  const rl = events.find((e) => e.kind === 'rate_limit');
  assert.ok(rl && rl.kind === 'rate_limit');
  assert.equal(rl.category, 'rate_limit');
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: spawn args use exec --json and pass tmp file', async () => {
  const fake = createFakeSpawn({ stdoutLines: [threadStarted] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do the thing',
    model: 'codex',
    workingDir: process.cwd(),
  });
  await handle.result;

  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.command, 'codex');
  assert.equal(call.args[0], 'exec');
  assert.ok(call.args.includes('--json'));
  assert.ok(call.args.includes('--sandbox'));
  assert.ok(call.args.includes('workspace-write'));
  assert.ok(call.args.includes('--output-last-message'));
  assert.equal(call.args[call.args.length - 1], 'do the thing');
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: resume uses exec resume <id>', async () => {
  const fake = createFakeSpawn({ stdoutLines: [threadStarted] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'continue',
    model: 'codex',
    workingDir: process.cwd(),
    sessionId: 'prev-thread-1',
  });
  await handle.result;

  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.args[0], 'exec');
  assert.equal(call.args[1], 'resume');
  assert.equal(call.args[2], 'prev-thread-1');
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: 401 surfaces as error (auth), not rate_limit', async () => {
  // Auth failures must NOT be retried by the orchestrator — they need a hard
  // `error` event so the operator gets paged. A 401 dressed as a `rate_limit`
  // event would loop the worker pool forever on the same dead credential.
  const authError = JSON.stringify({
    type: 'error',
    error: { message: 'unauthorized', status: 401 },
  });
  const fake = createFakeSpawn({ stdoutLines: [threadStarted, authError] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'codex',
    workingDir: process.cwd(),
  });
  const events = await collect(handle.events);
  await handle.result;
  const rl = events.find((e) => e.kind === 'rate_limit');
  assert.equal(rl, undefined, '401 must not produce a rate_limit event');
  const err = events.find((e) => e.kind === 'error');
  assert.ok(err && err.kind === 'error');
  assert.equal(err.category, 'authentication_failed');
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: reassembles JSON line split across stdout chunks', async () => {
  const line = JSON.stringify({ type: 'thread.started', thread_id: 'codex-chunked-thread' });
  const chunks = [line.slice(0, 7), line.slice(7, 25), line.slice(25), '\n'];
  const fake = createFakeSpawn({ stdoutChunks: chunks });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'codex',
    workingDir: process.cwd(),
  });
  assert.equal(await handle.sessionId, 'codex-chunked-thread');
  await handle.result;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codexChildEnv: scrubs secrets, keeps only the allowlist', () => {
  // A prompt-injected codex run must not be able to echo any of these.
  const source: NodeJS.ProcessEnv = {
    HOME: '/home/agent',
    PATH: '/usr/bin',
    CODEX_HOME: '/home/agent/.codex',
    LANG: 'en_US.UTF-8',
    GITHUB_TOKEN: 'ghp_SECRET',
    DISCORD_BOT_TOKEN: 'discord_SECRET',
    IFLEET_HMAC_SECRET: 'hmac_SECRET',
    ANTHROPIC_API_KEY: 'sk-ant-SECRET',
    OPENAI_API_KEY: 'sk-openai-SECRET',
  };

  const env = codexChildEnv(source);

  // Secrets are gone.
  assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must not leak');
  assert.equal(env.DISCORD_BOT_TOKEN, undefined, 'DISCORD_BOT_TOKEN must not leak');
  assert.equal(env.IFLEET_HMAC_SECRET, undefined, 'IFLEET_HMAC_SECRET must not leak');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must not leak');
  // OPENAI_API_KEY is gated behind includeApiKey (default off).
  assert.equal(env.OPENAI_API_KEY, undefined, 'OPENAI_API_KEY must not leak by default');

  // Allowlisted operational keys survive.
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CODEX_HOME, '/home/agent/.codex');
  assert.equal(env.LANG, 'en_US.UTF-8');
});

test('codexChildEnv: includeApiKey forwards OPENAI_API_KEY only when asked', () => {
  const source: NodeJS.ProcessEnv = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-openai-SECRET' };
  assert.equal(codexChildEnv(source).OPENAI_API_KEY, undefined);
  assert.equal(codexChildEnv(source, { includeApiKey: true }).OPENAI_API_KEY, 'sk-openai-SECRET');
});

test('codex finalize: clean run returns ok:true', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [threadStarted, assistantCompleted, turnCompleted],
  });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({ taskId: 't', brief: 'do', model: 'codex', workingDir: process.cwd() });
  const result = await handle.result;
  assert.equal(result.ok, true);
  assert.equal(result.rateLimited, undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex finalize: rate-limit on a zero-exit run returns ok:false + rateLimited', async () => {
  const fake = createFakeSpawn({ stdoutLines: [threadStarted, rateLimitError] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({ taskId: 't', brief: 'do', model: 'codex', workingDir: process.cwd() });
  const result = await handle.result;
  assert.equal(result.ok, false, 'rate-limited run must not be reported as success');
  assert.equal(result.rateLimited, true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex finalize: rate-limit then non-zero exit reclassifies to ok:false (not a crash)', async () => {
  const fake = createFakeSpawn({ stdoutLines: [threadStarted, rateLimitError], exitCode: 1 });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({ taskId: 't', brief: 'do', model: 'codex', workingDir: process.cwd() });
  const result = await handle.result;
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex finalize: hard error (auth) returns ok:false', async () => {
  const authError = JSON.stringify({ type: 'error', error: { message: 'unauthorized', status: 401 } });
  const fake = createFakeSpawn({ stdoutLines: [threadStarted, authError] });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({ taskId: 't', brief: 'do', model: 'codex', workingDir: process.cwd() });
  const result = await handle.result;
  assert.equal(result.ok, false, 'auth-failed run must not be reported as success');
  assert.equal(result.rateLimited, undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('codex adapter: non-zero exit rejects result with stderr tail', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [threadStarted],
    stderrLines: ['fatal: missing api key'],
    exitCode: 2,
  });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ifleet-codex-test-'));
  const adapter = createCodexAdapter({ spawnImpl: fake.spawn, tmpRoot });
  const handle = adapter.spawn({
    taskId: 't',
    brief: 'do',
    model: 'codex',
    workingDir: process.cwd(),
  });

  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    assert.equal(err.exitCode, 2);
    assert.ok(err.stderrTail.includes('missing api key'));
    return true;
  });
  rmSync(tmpRoot, { recursive: true, force: true });
});
