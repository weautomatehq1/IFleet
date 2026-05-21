import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const _generationEnd = vi.fn();
const _traceUpdate = vi.fn();
const _generation = vi.fn(() => ({ end: _generationEnd }));
const _trace = vi.fn(() => ({ generation: _generation, update: _traceUpdate }));
const _flushAsync = vi.fn(() => Promise.resolve());

vi.mock('langfuse', () => {
  class LangfuseMock {
    trace = _trace;
    flushAsync = _flushAsync;
  }
  return { Langfuse: LangfuseMock };
});
import {
  getLangfuseClient,
  resetLangfuseClient,
  startTrace,
} from '../langfuse.ts';

describe('langfuse client singleton', () => {
  beforeEach(() => {
    resetLangfuseClient();
  });
  afterEach(() => {
    resetLangfuseClient();
  });

  it('returns null when public/secret keys are absent', () => {
    expect(getLangfuseClient({ publicKey: undefined, secretKey: undefined })).toBeNull();
  });

  it('returns null when only one key is provided', () => {
    expect(getLangfuseClient({ publicKey: 'pk-lf-x', secretKey: undefined })).toBeNull();
  });

  it('caches the disabled state across calls', () => {
    const a = getLangfuseClient({ publicKey: undefined, secretKey: undefined });
    const b = getLangfuseClient({ publicKey: 'pk-lf-x', secretKey: 'sk-lf-y' });
    expect(a).toBeNull();
    // cached null is sticky — explicit reset is required to re-init
    expect(b).toBeNull();
  });

  it('constructs a client when both keys are present', () => {
    const client = getLangfuseClient({
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      baseUrl: 'http://localhost:3010',
    });
    expect(client).not.toBeNull();
  });
});

describe('startTrace', () => {
  beforeEach(() => {
    resetLangfuseClient();
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
  });
  afterEach(() => {
    resetLangfuseClient();
  });

  it('returns a no-op trace when Langfuse is disabled', () => {
    const trace = startTrace({
      name: 'architect',
      taskId: 't1',
      workerId: 'claude-max-1',
      model: 'claude-opus-4-7',
      brief: 'do the thing',
    });
    // Must not throw. End-of-life is a no-op when disabled.
    expect(() => trace.end({ ok: true, exitCode: 0 })).not.toThrow();
  });

  it('observability failure never crashes — bad end() output is swallowed', () => {
    const trace = startTrace({
      name: 'worker',
      taskId: 't2',
      workerId: 'claude-max-1',
      model: 'claude-sonnet-4-6',
      brief: 'b',
    });
    // Pathological output (huge string) should still be safe.
    expect(() =>
      trace.end({
        ok: false,
        exitCode: 1,
        error: 'x'.repeat(100_000),
        outputText: 'y'.repeat(100_000),
      }),
    ).not.toThrow();
  });
});

describe('startTrace — happy path (Langfuse enabled)', () => {
  beforeEach(() => {
    resetLangfuseClient();
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-lf-test';
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-lf-test';
    process.env['LANGFUSE_BASE_URL'] = 'http://localhost:3010';
    _trace.mockClear();
    _generation.mockClear();
    _generationEnd.mockClear();
    _traceUpdate.mockClear();
    _flushAsync.mockClear();
  });
  afterEach(() => {
    resetLangfuseClient();
    delete process.env['LANGFUSE_PUBLIC_KEY'];
    delete process.env['LANGFUSE_SECRET_KEY'];
    delete process.env['LANGFUSE_BASE_URL'];
  });

  it('calls trace(), generation(), generation.end(), and flushAsync() on happy path', () => {
    const handle = startTrace({
      name: 'architect',
      taskId: 'task-123',
      workerId: 'claude-max-1',
      model: 'claude-opus-4-7',
      brief: 'implement the feature',
    });

    handle.end({
      ok: true,
      exitCode: 0,
      totalCostUsd: 0.005,
      durationMs: 1200,
      outputText: 'hi',
    });

    // client.trace() called with name + input.
    expect(_trace).toHaveBeenCalledWith(expect.objectContaining({
      name: 'architect',
      input: { brief: 'implement the feature' },
    }));

    // trace.generation() called with name + model.
    expect(_generation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'architect',
      model: 'claude-opus-4-7',
    }));

    // generation.end() called with cost — note: `usageDetails` until AUDIT-IFleet-544ccbcb (T2) merges.
    expect(_generationEnd).toHaveBeenCalledWith(expect.objectContaining({
      usageDetails: { totalCostUsd: 0.005 },
      output: 'hi',
      level: 'DEFAULT',
    }));

    // flushAsync() called to ship the trace before process exit.
    expect(_flushAsync).toHaveBeenCalled();
  });
});
