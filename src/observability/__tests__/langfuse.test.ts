import { readFileSync } from 'node:fs';
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

  it('emits usageDetails with snake_case keys (input_tokens / output_tokens / total_tokens)', () => {
    // Read the langfuse module source to assert the literal keys we send to
    // the Langfuse SDK. The SDK expects snake_case keys for usageDetails per
    // https://langfuse.com/docs/sdk/typescript/guide#usage. Asserting the
    // shape at the source level avoids a flaky integration test against the
    // singleton/network client.
    const src = readFileSync(
      new URL('../langfuse.ts', import.meta.url),
      'utf-8',
    );
    // Find the usageDetails object literal.
    const match = src.match(/usageDetails:[\s\S]{0,200}?\{([\s\S]{0,200}?)\}/);
    expect(match, 'usageDetails block not found in langfuse.ts').not.toBeNull();
    const block = match?.[1] ?? '';
    expect(block).toContain('input_tokens');
    expect(block).toContain('output_tokens');
    expect(block).toContain('total_tokens');
    expect(block).not.toContain('totalCostUsd');
    expect(block).not.toContain('inputTokens:');
    expect(block).not.toContain('outputTokens:');
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
