import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetPipelineAdapterRegistry,
  getActivePipelineAdapter,
  hasPipelineAdapter,
  listPipelineAdapters,
  registerPipelineAdapter,
  resolvePipelineAdapter,
} from '../pipeline-registry.ts';
import { ADAPTER_ENV_VAR, DEFAULT_ADAPTER_NAME } from '../registry.ts';
import type { SpawnHandle, SpawnOpts, WorkerAdapter } from '../../types.ts';

function stubAdapter(tag: string): WorkerAdapter {
  return {
    provider: 'claude',
    spawn(_opts: SpawnOpts): SpawnHandle {
      return {
        pid: 0,
        sessionId: Promise.resolve(tag),
        events: (async function* () { /* no events */ })(),
        cancel: async () => undefined,
        result: Promise.resolve({ ok: true, text: tag, sessionId: tag, durationMs: 0 }),
      };
    },
  };
}

test('pipeline-registry: register + resolve round-trip', () => {
  __resetPipelineAdapterRegistry();
  registerPipelineAdapter('alpha', () => stubAdapter('alpha'));
  const resolved = resolvePipelineAdapter('alpha');
  assert.equal(typeof resolved.spawn, 'function');
  assert.ok(hasPipelineAdapter('alpha'));
  assert.deepEqual([...listPipelineAdapters()], ['alpha']);
});

test('pipeline-registry: rejects empty name', () => {
  __resetPipelineAdapterRegistry();
  assert.throws(() => registerPipelineAdapter('', () => stubAdapter('x')), /must not be empty/);
});

test('pipeline-registry: resolve throws on unknown name with helpful list', () => {
  __resetPipelineAdapterRegistry();
  registerPipelineAdapter('a', () => stubAdapter('a'));
  assert.throws(() => resolvePipelineAdapter('missing'), /Unknown pipeline WorkerAdapter "missing".*a/);
});

test('getActivePipelineAdapter: defaults to claude-cli when env var unset', async () => {
  __resetPipelineAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  delete process.env[ADAPTER_ENV_VAR];
  try {
    registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter('default'));
    const adapter = getActivePipelineAdapter();
    assert.equal(adapter.provider, 'claude');
  } finally {
    if (previous !== undefined) process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActivePipelineAdapter: honors IFLEET_ADAPTER env var', async () => {
  __resetPipelineAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = 'vllm-local';
  try {
    registerPipelineAdapter('vllm-local', () => stubAdapter('vllm-local'));
    registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter(DEFAULT_ADAPTER_NAME));
    const adapter = getActivePipelineAdapter();
    const text = await adapter.spawn({
      taskId: 't',
      brief: '',
      model: 'm',
      workingDir: '.',
    }).result;
    assert.equal(text.text, 'vllm-local');
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActivePipelineAdapter: empty IFLEET_ADAPTER falls back to default', async () => {
  __resetPipelineAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = '';
  try {
    registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter(DEFAULT_ADAPTER_NAME));
    const adapter = getActivePipelineAdapter();
    const r = await adapter.spawn({ taskId: 't', brief: '', model: 'm', workingDir: '.' }).result;
    assert.equal(r.text, DEFAULT_ADAPTER_NAME);
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActivePipelineAdapter: throws when env var points at unknown adapter', () => {
  __resetPipelineAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = 'does-not-exist';
  try {
    assert.throws(() => getActivePipelineAdapter(), /Unknown pipeline WorkerAdapter "does-not-exist"/);
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});
