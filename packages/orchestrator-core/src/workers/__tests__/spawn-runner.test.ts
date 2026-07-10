import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStreaming } from '../spawn-runner.ts';
import { WorkerCrashError } from '../types.ts';
import { createFakeSpawn } from './fake-spawn.ts';

test('runStreaming: cancel sends SIGTERM, escalates to SIGKILL after grace', async () => {
  const fake = createFakeSpawn({
    stdoutLines: ['{"type":"system","subtype":"init","session_id":"s1"}'],
    hangUntilSignal: true,
    ignoreSigterm: true,
    killDelayMs: 0,
  });
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    killGraceMs: 30,
    parseLine: () => undefined,
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  await handle.cancel();
  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    assert.equal(err.signal, 'SIGKILL');
    return true;
  });
});

test('runStreaming: AbortSignal triggers cancel', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [],
    hangUntilSignal: true,
    ignoreSigterm: false,
    killDelayMs: 0,
  });
  const controller = new AbortController();
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    signal: controller.signal,
    killGraceMs: 30,
    parseLine: () => undefined,
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  controller.abort();
  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    assert.equal(err.signal, 'SIGTERM');
    return true;
  });
});

test('runStreaming: reassembles lines split across multiple stdout chunks', async () => {
  // One JSON object delivered as 6 chunks: only the last chunk closes with \n.
  const json = '{"type":"system","subtype":"init","session_id":"s-chunked-1"}';
  const chunks = [json.slice(0, 5), json.slice(5, 18), json.slice(18, 30), json.slice(30, 45), json.slice(45), '\n'];
  const parsed: unknown[] = [];
  const fake = createFakeSpawn({ stdoutChunks: chunks, exitCode: 0 });
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    parseLine: (line) => {
      parsed.push(JSON.parse(line));
    },
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  await handle.result;
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { type: 'system', subtype: 'init', session_id: 's-chunked-1' });
});

test('runStreaming: drains heavy stderr without deadlocking the child', async () => {
  const stderrLines = Array.from({ length: 5000 }, (_, i) => `noise-line-${i}`);
  const fake = createFakeSpawn({
    stdoutLines: ['{"type":"system","subtype":"init","session_id":"s-stderr-drain"}'],
    stderrLines,
    exitCode: 0,
  });
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    stderrTailLines: 10,
    parseLine: () => undefined,
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  const result = await handle.result;
  // If stderr drainage was broken we'd never reach this assert — the child
  // would back-pressure the pipe and the close event would never fire.
  assert.equal(result.ok, true);
});

test('runStreaming: cancel rejects result with WorkerCrashError even with pending events', async () => {
  const fake = createFakeSpawn({
    stdoutLines: [
      '{"type":"system","subtype":"init","session_id":"s-cancel"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
    ],
    hangUntilSignal: true,
    ignoreSigterm: false,
  });
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    killGraceMs: 50,
    parseLine: (line, emit) => {
      const evt = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string };
      if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
        emit({ kind: 'init', sessionId: evt.session_id });
      }
    },
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  // Wait for init so events are populated before cancelling.
  await handle.sessionId;
  void handle.cancel();
  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    return true;
  });
});

test('runStreaming: stderr tail captures last N lines', async () => {
  const stderrLines = Array.from({ length: 150 }, (_, i) => `err-line-${i}`);
  const fake = createFakeSpawn({
    stdoutLines: [],
    stderrLines,
    exitCode: 1,
  });
  const handle = runStreaming({
    command: 'fake',
    args: [],
    cwd: process.cwd(),
    spawnImpl: fake.spawn,
    stderrTailLines: 50,
    parseLine: () => undefined,
    finalize: ({ startedAt, endedAt, sessionId }) => ({
      ok: true,
      text: '',
      sessionId,
      durationMs: endedAt - startedAt,
    }),
  });

  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof WorkerCrashError);
    const lines = err.stderrTail.split('\n');
    assert.equal(lines.length, 50);
    assert.equal(lines[0], 'err-line-100');
    assert.equal(lines[49], 'err-line-149');
    return true;
  });
});
