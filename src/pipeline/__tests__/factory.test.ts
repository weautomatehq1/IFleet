// Regression cover for F5 — the PR opener ran `gh pr create --reviewer
// @monstersebas1`. The `@` prefix made `gh` reject the login, so `gh` exited
// non-zero *after* creating the PR, failing the whole task over a non-essential
// step. normalizeReviewers strips the `@` so `gh` gets a bare login.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildWorkerPool, FIVE_HOURS_MS, normalizeReviewers } from '../factory.js';
import { classifyTask } from '../../classifier/index.js';
import type { AccountPool, AcquireResult } from '../../workers/account-pool.js';
import type { WorkerConfig } from '../../orchestrator/types.js';
import type {
  SpawnHandle as AdapterSpawnHandle,
  SpawnOpts as AdapterSpawnOpts,
  WorkerAdapter,
  WorkerEvent,
  WorkerResult,
} from '../../workers/types.js';
import {
  __resetPipelineAdapterRegistry,
  registerPipelineAdapter,
  createClaudeCliPipelineAdapter,
} from '../../workers/adapters/pipeline-registry.js';
import { DEFAULT_ADAPTER_NAME } from '../../workers/adapters/registry.js';
import type { WorkerSpec } from '../types.js';

describe('F5: normalizeReviewers — gh-safe reviewer logins', () => {
  it('strips a leading @ (CODEOWNERS / config store @user)', () => {
    expect(normalizeReviewers(['@monstersebas1'])).toEqual(['monstersebas1']);
  });

  it('leaves bare logins untouched', () => {
    expect(normalizeReviewers(['monstersebas1', 'esmelyvaldivieso99-code'])).toEqual([
      'monstersebas1',
      'esmelyvaldivieso99-code',
    ]);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(normalizeReviewers(['@x', '', '  ', '@@y'])).toEqual(['x', 'y']);
  });

  it('returns an empty array when there are no reviewers', () => {
    expect(normalizeReviewers([])).toEqual([]);
  });
});

describe('AUDIT-IFleet-e8b8cbc4: classifyTask propagates mode from QueuedTask', () => {
  it('preserves mode: ralph in the routing decision', () => {
    const decision = classifyTask({
      title: 'fix broken widget',
      body: 'some body',
      labels: [],
      mode: 'ralph',
    });
    expect(decision.mode).toBe('ralph');
  });
});

describe('M6-T3: factory persists RoutingDecision and records shadow pick', () => {
  // Source-level guard mirrors AUDIT-IFleet-d3e66e4a's pattern. A future
  // refactor that drops the persist+shadow step on the floor would still
  // typecheck — this assertion catches it at the call site.
  it('factory.ts calls setRoutingDecision + recordShadowDecision after classifyTask', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/opts\.taskStore\.setRoutingDecision\(task\.id, routing\)/);
    expect(src).toMatch(/recordShadowDecision\(/);
    expect(src).toMatch(/buildShadowObservations\(/);
    expect(src).toMatch(/knownArms:\s*KNOWN_MODEL_IDS/);
  });

  it('factory.ts loops over all three roles (architect, editor, reviewer)', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const ROLES = \['architect', 'editor', 'reviewer'\] as const/);
    expect(src).toMatch(/for \(const role of ROLES\)/);
    expect(src).toMatch(/role,?\s*$/m);
  });

  it('each role call is wrapped in its own try/catch so a single-role failure cannot skip the others', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    // The for-loop body must be a try{ recordShadowDecision } catch{ console.warn }
    // so a throw in (e.g.) the editor call still lets the reviewer call fire.
    const block = src.match(
      /for \(const role of ROLES\)\s*\{\s*try\s*\{[\s\S]*?recordShadowDecision[\s\S]*?\}\s*catch[\s\S]*?console\.warn/,
    );
    expect(
      block,
      'per-role try/catch around recordShadowDecision not found in factory.ts',
    ).not.toBeNull();
  });
});

describe('AUDIT-IFleet-d3e66e4a: factory integration passes mode through to classifyTask', () => {
  // The above classifier test would still pass if factory.ts dropped mode on the
  // floor before invoking classifyTask. Lock the actual call site at the source
  // level so future refactors can't silently regress the integration.
  it('factory.ts calls classifyTask with mode: task.mode', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    const call = src.match(/classifyTask\(\{[^}]*\}\)/);
    expect(call, 'classifyTask call not found in factory.ts').not.toBeNull();
    expect(call?.[0] ?? '').toMatch(/mode:\s*task\.mode/);
  });
});

// ADR-0004 §Context bullet 1 — rate_limit events received by the worker pool
// must flow into AccountPool.markRateLimited so subsequent acquire() calls
// skip the rate-limited worker. Previously the pipeline only counted hits
// for observability; the pool never reacted in the live path.
describe('rate_limit event wires AccountPool.markRateLimited', () => {
  const FAKE_ADAPTER_NAME = 'fake-rate-limit-adapter';
  let queuedEvents: WorkerEvent[] = [];

  function buildFakeAdapter(): WorkerAdapter {
    return {
      provider: 'claude',
      spawn(_opts: AdapterSpawnOpts): AdapterSpawnHandle {
        const events = queuedEvents.slice();
        return {
          pid: 1,
          sessionId: Promise.resolve('fake-session'),
          events: (async function* () {
            for (const event of events) yield event;
          })(),
          cancel: async () => undefined,
          result: Promise.resolve<WorkerResult>({
            ok: true,
            text: '',
            sessionId: 'fake-session',
            durationMs: 0,
          }),
        };
      },
    };
  }

  function makeMockPool(): { pool: AccountPool; calls: Array<{ id: string; retryAfterMs: number }> } {
    const calls: Array<{ id: string; retryAfterMs: number }> = [];
    const pool: AccountPool = {
      nextWorker: () => {
        throw new Error('nextWorker should not be called in this test');
      },
      acquire: (): AcquireResult => ({ kind: 'empty' }),
      workerCount: () => 1,
      markRateLimited: (id: string, retryAfterMs: number) => {
        calls.push({ id, retryAfterMs });
      },
      markAuthFailed: () => undefined,
      pausedUntil: () => null,
    };
    return { pool, calls };
  }

  const workerConfig: WorkerConfig = {
    id: 'claude-max-test',
    provider: 'claude',
    authProfile: 'default',
    models: ['sonnet-4.6'],
    maxConcurrent: 1,
    enabled: true,
  };

  const spec: WorkerSpec = {
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    workerId: 'editor-1',
  };

  beforeEach(() => {
    __resetPipelineAdapterRegistry();
    registerPipelineAdapter(FAKE_ADAPTER_NAME, buildFakeAdapter);
    queuedEvents = [];
    process.env.IFLEET_ADAPTER = FAKE_ADAPTER_NAME;
  });

  afterAll(() => {
    delete process.env.IFLEET_ADAPTER;
    __resetPipelineAdapterRegistry();
    registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => createClaudeCliPipelineAdapter());
  });

  it('rate_limit event triggers pool.markRateLimited with the spawn-time worker id', async () => {
    const { pool, calls } = makeMockPool();
    queuedEvents = [
      { kind: 'rate_limit', retryDelayMs: 12_345, category: 'rate_limit' },
    ];
    const wp = buildWorkerPool(workerConfig, pool);

    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    const result = await handle.result();

    expect(calls).toEqual([{ id: 'claude-max-test', retryAfterMs: 12_345 }]);
    expect(result.rateLimitHits).toBe(1);
  });

  it('rate_limit event with retryDelayMs=0 falls back to the five-hour default', async () => {
    const { pool, calls } = makeMockPool();
    queuedEvents = [
      { kind: 'rate_limit', retryDelayMs: 0, category: 'rate_limit' },
    ];
    const wp = buildWorkerPool(workerConfig, pool);

    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    await handle.result();

    expect(calls).toEqual([{ id: 'claude-max-test', retryAfterMs: FIVE_HOURS_MS }]);
  });

  it('rateLimitHits counter still increments alongside the pool call', async () => {
    const { pool, calls } = makeMockPool();
    queuedEvents = [
      { kind: 'rate_limit', retryDelayMs: 1_000, category: 'rate_limit' },
      { kind: 'rate_limit', retryDelayMs: 2_000, category: 'rate_limit' },
    ];
    const wp = buildWorkerPool(workerConfig, pool);

    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    const result = await handle.result();

    expect(result.rateLimitHits).toBe(2);
    expect(calls).toEqual([
      { id: 'claude-max-test', retryAfterMs: 1_000 },
      { id: 'claude-max-test', retryAfterMs: 2_000 },
    ]);
  });

  it('factory works when the pool is not provided (back-compat path)', async () => {
    queuedEvents = [
      { kind: 'rate_limit', retryDelayMs: 1_000, category: 'rate_limit' },
    ];
    const wp = buildWorkerPool(workerConfig); // no pool passed

    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    const result = await handle.result();

    expect(result.rateLimitHits).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('non-rate_limit events do not call markRateLimited', async () => {
    const { pool, calls } = makeMockPool();
    queuedEvents = [
      { kind: 'progress', text: 'hello' },
      { kind: 'tool_use', name: 'Read', input: {} },
    ];
    const wp = buildWorkerPool(workerConfig, pool);

    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    const result = await handle.result();

    expect(calls).toEqual([]);
    expect(result.rateLimitHits).toBe(0);
  });
});
