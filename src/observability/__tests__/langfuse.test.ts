import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
