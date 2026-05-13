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
