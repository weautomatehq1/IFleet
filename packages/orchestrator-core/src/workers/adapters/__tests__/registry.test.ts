import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_ENV_VAR,
  DEFAULT_ADAPTER_NAME,
  __resetAdapterRegistry,
  getActiveAdapter,
  hasAdapter,
  listAdapters,
  registerAdapter,
  resolveAdapter,
} from '../registry.ts';
import type {
  SpawnHandle,
  SpawnOpts,
  TaskId,
  WorkerAdapter,
} from '../../../../../../src/orchestrator/types.ts';

function stubAdapter(tag: string): WorkerAdapter {
  return {
    async spawn(taskId: TaskId, _brief: string, _opts: SpawnOpts): Promise<SpawnHandle> {
      return {
        workerId: tag,
        taskId,
        cancel: async () => undefined,
        done: Promise.resolve({ taskId, workerId: tag, exitCode: 0 }),
      };
    },
  };
}

test('registry: registerAdapter + resolveAdapter round-trip', () => {
  __resetAdapterRegistry();
  registerAdapter('alpha', () => stubAdapter('alpha'));
  const resolved = resolveAdapter('alpha');
  assert.equal(typeof resolved.spawn, 'function');
  assert.ok(hasAdapter('alpha'));
  assert.deepEqual([...listAdapters()], ['alpha']);
});

test('registry: factory is called on every resolveAdapter', () => {
  __resetAdapterRegistry();
  let constructions = 0;
  registerAdapter('counted', () => {
    constructions += 1;
    return stubAdapter('counted');
  });
  resolveAdapter('counted');
  resolveAdapter('counted');
  assert.equal(constructions, 2);
});

test('registry: resolveAdapter throws on unknown name with helpful list', () => {
  __resetAdapterRegistry();
  registerAdapter('a', () => stubAdapter('a'));
  registerAdapter('b', () => stubAdapter('b'));
  assert.throws(() => resolveAdapter('missing'), /Unknown WorkerAdapter "missing".*a, b/);
});

test('registry: resolveAdapter error lists "(none registered)" when empty', () => {
  __resetAdapterRegistry();
  assert.throws(() => resolveAdapter('x'), /\(none registered\)/);
});

test('registry: registerAdapter rejects empty name', () => {
  __resetAdapterRegistry();
  assert.throws(() => registerAdapter('', () => stubAdapter('x')), /must not be empty/);
});

test('registry: multiple adapters can coexist without clobber', () => {
  __resetAdapterRegistry();
  registerAdapter('one', () => stubAdapter('one'));
  registerAdapter('two', () => stubAdapter('two'));
  registerAdapter('three', () => stubAdapter('three'));
  const names = [...listAdapters()].sort();
  assert.deepEqual(names, ['one', 'three', 'two']);
});

test('registry: re-registering same name overwrites (last wins)', async () => {
  __resetAdapterRegistry();
  registerAdapter('dup', () => stubAdapter('first'));
  registerAdapter('dup', () => stubAdapter('second'));
  const resolved = resolveAdapter('dup');
  const handle = await resolved.spawn('t' as TaskId, '', {});
  assert.equal(handle.workerId, 'second');
});

test('getActiveAdapter: defaults to claude-cli when env var unset', () => {
  __resetAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  delete process.env[ADAPTER_ENV_VAR];
  try {
    registerAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter(DEFAULT_ADAPTER_NAME));
    const adapter = getActiveAdapter();
    assert.equal(typeof adapter.spawn, 'function');
  } finally {
    if (previous !== undefined) process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActiveAdapter: honors IFLEET_ADAPTER env var', async () => {
  __resetAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = 'vllm-local';
  try {
    registerAdapter('vllm-local', () => stubAdapter('vllm-local'));
    registerAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter(DEFAULT_ADAPTER_NAME));
    const adapter = getActiveAdapter();
    const h = await adapter.spawn('t' as TaskId, '', {});
    assert.equal(h.workerId, 'vllm-local');
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActiveAdapter: empty IFLEET_ADAPTER falls back to default', async () => {
  __resetAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = '';
  try {
    registerAdapter(DEFAULT_ADAPTER_NAME, () => stubAdapter(DEFAULT_ADAPTER_NAME));
    const h = await getActiveAdapter().spawn('t' as TaskId, '', {});
    assert.equal(h.workerId, DEFAULT_ADAPTER_NAME);
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});

test('getActiveAdapter: throws when env var points at unknown adapter', () => {
  __resetAdapterRegistry();
  const previous = process.env[ADAPTER_ENV_VAR];
  process.env[ADAPTER_ENV_VAR] = 'does-not-exist';
  try {
    assert.throws(() => getActiveAdapter(), /Unknown WorkerAdapter "does-not-exist"/);
  } finally {
    if (previous === undefined) delete process.env[ADAPTER_ENV_VAR];
    else process.env[ADAPTER_ENV_VAR] = previous;
  }
});
