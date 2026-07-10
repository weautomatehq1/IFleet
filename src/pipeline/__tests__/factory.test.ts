// Regression cover for F5 — the PR opener ran `gh pr create --reviewer
// @monstersebas1`. The `@` prefix made `gh` reject the login, so `gh` exited
// non-zero *after* creating the PR, failing the whole task over a non-essential
// step. normalizeReviewers strips the `@` so `gh` gets a bare login.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { applyBanditRouting, buildWorkerPool, FIVE_HOURS_MS, logPostRoutingDecision, normalizeReviewers } from '../factory.js';
import { classifyTask } from '../../classifier/index.js';
import { readShadowDecisions } from '../../agents/bandit/shadow.js';
import { KNOWN_MODEL_IDS } from '../../agents/bandit/known-arms.js';
import type { RoutingDecision } from '../types.js';
import type { AccountPool, AcquireResult } from '@wahq/orchestrator-core/workers/account-pool';
import type { WorkerConfig } from '../../orchestrator/types.js';
import type {
  SpawnHandle as AdapterSpawnHandle,
  SpawnOpts as AdapterSpawnOpts,
  WorkerAdapter,
  WorkerEvent,
  WorkerResult,
} from '@wahq/orchestrator-core/workers/types';
import {
  __resetPipelineAdapterRegistry,
  registerPipelineAdapter,
  createClaudeCliPipelineAdapter,
} from '@wahq/orchestrator-core/workers/adapters/pipeline-registry';
import { DEFAULT_ADAPTER_NAME } from '@wahq/orchestrator-core/workers/adapters/registry';
import { createFakeSpawn } from '../../../packages/orchestrator-core/src/workers/__tests__/fake-spawn.js';
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
  it('factory.ts calls setRoutingDecision + resolveRoutingModel after classifyTask', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/setRoutingDecision\(opts\.taskStore, task\.id, routing\)/);
    // AUDIT-IFleet-406c8c3e: shadow logging now flows through the live seam
    // (resolveRoutingModel calls recordShadowDecision internally).
    expect(src).toMatch(/resolveRoutingModel\(/);
    expect(src).toMatch(/buildShadowObservations\(/);
    expect(src).toMatch(/knownArms:\s*KNOWN_MODEL_IDS/);
  });

  it('factory.ts wires the gated BANDIT_LIVE flip — overridden ⇒ promote sampled arm', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    // The single live mutation point: only fires when resolveRoutingModel
    // reports an override (which is impossible while BANDIT_LIVE is OFF).
    expect(src).toMatch(/if \(routed\.overridden\)\s*\{\s*routing\[role\]\.model = routed\.model;/);
  });

  it('factory.ts loops over all three roles (architect, editor, reviewer)', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/const ROLES = \['architect', 'editor', 'reviewer'\] as const/);
    expect(src).toMatch(/for \(const role of ROLES\)/);
    expect(src).toMatch(/role,?\s*$/m);
  });

  it('each role call is wrapped in its own try/catch so a single-role failure cannot skip the others', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    // The for-loop body must be a try{ resolveRoutingModel } catch{ console.warn }
    // so a throw in (e.g.) the editor call still lets the reviewer call fire.
    const block = src.match(
      /for \(const role of ROLES\)\s*\{\s*try\s*\{[\s\S]*?resolveRoutingModel[\s\S]*?\}\s*catch[\s\S]*?console\.warn/,
    );
    expect(
      block,
      'per-role try/catch around resolveRoutingModel not found in factory.ts',
    ).not.toBeNull();
  });
});

describe('AUDIT-IFleet-406c8c3e: applyBanditRouting wires the gated BANDIT_LIVE flip', () => {
  // Integration-style: drive the real factory wiring (applyBanditRouting →
  // resolveRoutingModel → recordShadowDecision) against an in-memory sqlite db
  // and a real RoutingDecision. Proves the seam the audit flagged as dead.

  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, routing_decision TEXT);
      CREATE TABLE pr_decisions (task_id TEXT, repo TEXT, verdict TEXT);
      CREATE TABLE routing_shadow_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        actual_model TEXT NOT NULL,
        shadow_model TEXT NOT NULL,
        alpha_snapshot TEXT NOT NULL,
        beta_snapshot TEXT NOT NULL,
        sample_snapshot TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'architect',
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    db.prepare('INSERT INTO tasks (id) VALUES (?)').run('task-1');
    return db;
  }

  // Sentinels that are NOT known arms — so a sampled arm (always ∈ KNOWN_MODEL_IDS)
  // can never coincidentally equal them. The flip is then provable for any rng.
  const SENTINEL = {
    architect: '__live_architect__',
    editor: '__live_editor__',
    reviewer: '__live_reviewer__',
  } as const;

  function makeRouting(): RoutingDecision {
    return {
      architect: { provider: 'claude', model: SENTINEL.architect, workerId: 'w-a' },
      editor: { provider: 'claude', model: SENTINEL.editor, workerId: 'w-e' },
      reviewer: { provider: 'claude', model: SENTINEL.reviewer, workerId: 'w-r' },
      verify: ['typecheck', 'test'],
    };
  }

  const TASK = { id: 'task-1', repo: 'weautomatehq1/IFleet' };

  it('flag OFF (default) ⇒ routing decision unchanged, but all three shadow rows are still written', () => {
    const db = makeDb();
    const routing = makeRouting();

    applyBanditRouting(db, routing, TASK, { live: false, now: 1_700_000_000_000 });

    // Live decision byte-identical to classifyTask's output.
    expect(routing.architect.model).toBe(SENTINEL.architect);
    expect(routing.editor.model).toBe(SENTINEL.editor);
    expect(routing.reviewer.model).toBe(SENTINEL.reviewer);

    // Shadow logging preserved — one row per role.
    const rows = readShadowDecisions(db);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(['architect', 'editor', 'reviewer']));
    // Each row records the ORIGINAL live decision as actual_model.
    for (const r of rows) {
      expect(r.actualModel).toBe(SENTINEL[r.role]);
    }
  });

  it('flag ON ⇒ each role.model becomes its Thompson-sampled arm (a known arm), shadow row keeps the original', () => {
    const db = makeDb();
    const routing = makeRouting();

    applyBanditRouting(db, routing, TASK, { live: true, now: 1_700_000_000_000 });

    // Every role flipped to a real known arm — the sentinel is gone.
    for (const role of ['architect', 'editor', 'reviewer'] as const) {
      expect(routing[role].model).not.toBe(SENTINEL[role]);
      expect(KNOWN_MODEL_IDS).toContain(routing[role].model);
    }

    // Shadow rows still record the original live decision for analytics, and
    // shadow_model == the model we flipped to.
    const rows = readShadowDecisions(db);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.actualModel).toBe(SENTINEL[r.role]);
      expect(r.shadowModel).toBe(routing[r.role].model);
    }
  });

  it('fail-open: a shadow-write failure for one role never overrides AND does not skip the others', () => {
    // pr_decisions table dropped → buildShadowObservations throws for every
    // role; the per-role try/catch must swallow it and leave routing untouched.
    const db = makeDb();
    db.exec('DROP TABLE pr_decisions;');
    const routing = makeRouting();

    applyBanditRouting(db, routing, TASK, { live: true, now: 1_700_000_000_000 });

    expect(routing.architect.model).toBe(SENTINEL.architect);
    expect(routing.editor.model).toBe(SENTINEL.editor);
    expect(routing.reviewer.model).toBe(SENTINEL.reviewer);
  });
});

describe('B3 (20260618 audit): closure log records post-bandit final_tier', () => {
  // Regression cover for B3 — when BANDIT_LIVE=1 promotes the architect arm
  // to a different tier, the [ROUTING-DECISION-LOG] line must report the
  // tier that actually runs, not the classifier's original pick.

  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, routing_decision TEXT);
      CREATE TABLE pr_decisions (task_id TEXT, repo TEXT, verdict TEXT);
      CREATE TABLE routing_shadow_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        actual_model TEXT NOT NULL,
        shadow_model TEXT NOT NULL,
        alpha_snapshot TEXT NOT NULL,
        beta_snapshot TEXT NOT NULL,
        sample_snapshot TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'architect',
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
    `);
    db.prepare('INSERT INTO tasks (id) VALUES (?)').run('task-b3');
    return db;
  }

  it('logs the post-bandit architect tier when applyBanditRouting overrides the model', () => {
    // Classifier picks sonnet; bandit overrides to opus.
    const routing: RoutingDecision = {
      architect: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-a' },
      editor: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-e' },
      reviewer: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-r' },
      verify: ['typecheck', 'test'],
      _meta: { hitKeyword: null, rawScore: 0, finalTier: 'sonnet' },
    };

    // Simulate the post-bandit mutation that applyBanditRouting performs
    // when BANDIT_LIVE=1 promotes the Thompson-sampled arm.
    routing.architect.model = 'claude-opus-4-7';

    const lines: string[] = [];
    logPostRoutingDecision('task-b3', routing, () => '2026-06-18T06:00:00.000Z', (l) => lines.push(l));

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.replace(/^\[ROUTING-DECISION-LOG\] /, ''));
    expect(payload.final_tier).toBe('opus');
    expect(payload.final_tier).not.toBe(routing._meta!.finalTier);
    expect(payload.task_id).toBe('task-b3');
    expect(payload.decided_at).toBe('2026-06-18T06:00:00.000Z');
  });

  it('end-to-end: applyBanditRouting (live ON) then logPostRoutingDecision reflects the flipped tier', () => {
    const db = makeDb();
    // Classifier picks haiku; bandit will Thompson-sample a known arm
    // (necessarily a different model id, since haiku-test isn't a known arm).
    const routing: RoutingDecision = {
      architect: { provider: 'claude', model: 'haiku-test', workerId: 'w-a' },
      editor: { provider: 'claude', model: 'haiku-test', workerId: 'w-e' },
      reviewer: { provider: 'claude', model: 'haiku-test', workerId: 'w-r' },
      verify: ['typecheck', 'test'],
      _meta: { hitKeyword: null, rawScore: 0, finalTier: 'haiku' },
    };

    applyBanditRouting(db, routing, { id: 'task-b3', repo: 'weautomatehq1/IFleet' }, { live: true, now: 1_700_000_000_000 });

    // Bandit promoted architect to a known arm — modelToTier resolves to a
    // real tier (haiku/sonnet/opus); the sentinel 'haiku-test' would have
    // resolved to undefined.
    expect(routing.architect.model).not.toBe('haiku-test');

    const lines: string[] = [];
    logPostRoutingDecision('task-b3', routing, () => '2026-06-18T06:00:00.000Z', (l) => lines.push(l));

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.replace(/^\[ROUTING-DECISION-LOG\] /, ''));
    expect(['haiku', 'sonnet', 'opus']).toContain(payload.final_tier);
    // The architect.model after the bandit flip MUST map to the logged tier.
    const expectedTier =
      routing.architect.model === 'claude-opus-4-7' ? 'opus' :
      routing.architect.model === 'claude-sonnet-4-6' ? 'sonnet' :
      routing.architect.model === 'claude-haiku-4-5-20251001' ? 'haiku' : null;
    expect(payload.final_tier).toBe(expectedTier);
  });

  it('no _meta ⇒ no log line', () => {
    const routing: RoutingDecision = {
      architect: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-a' },
      editor: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-e' },
      reviewer: { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'w-r' },
      verify: ['typecheck', 'test'],
    };
    const lines: string[] = [];
    logPostRoutingDecision('task-b3', routing, () => '2026-06-18T06:00:00.000Z', (l) => lines.push(l));
    expect(lines).toHaveLength(0);
  });

  it('falls back to _meta.finalTier when architect.model is unknown', () => {
    // Defensive: an unmapped model id (e.g. a future arm not yet added to
    // TIERS) must not crash the log — it falls back to the classifier's tier.
    const routing: RoutingDecision = {
      architect: { provider: 'claude', model: 'claude-future-9-9', workerId: 'w-a' },
      editor: { provider: 'claude', model: 'claude-future-9-9', workerId: 'w-e' },
      reviewer: { provider: 'claude', model: 'claude-future-9-9', workerId: 'w-r' },
      verify: ['typecheck', 'test'],
      _meta: { hitKeyword: 'auth', rawScore: 5, finalTier: 'opus' },
    };
    const lines: string[] = [];
    logPostRoutingDecision('task-b3', routing, () => '2026-06-18T06:00:00.000Z', (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.replace(/^\[ROUTING-DECISION-LOG\] /, ''));
    expect(payload.final_tier).toBe('opus');
  });

  it('factory.ts emits the closure log AFTER applyBanditRouting (source-level guard)', () => {
    // After the RoutingStrategy seam (T3 20260710-0617-phase1-extraction), the
    // call sites live behind the injected strategy: `routingStrategy.applyBanditRouting`
    // then `routingStrategy.logDecision`. The ordering invariant (log AFTER apply
    // so final_tier reflects the model that actually runs — B3 from the
    // 20260618-0600-codex-bugs audit) still holds and is what the guard locks.
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    const applyIdx = src.indexOf('routingStrategy.applyBanditRouting(db, routing,');
    const logIdx = src.indexOf('routingStrategy.logDecision(task.id, routing)');
    expect(applyIdx, 'routingStrategy.applyBanditRouting call site not found').toBeGreaterThan(-1);
    expect(logIdx, 'routingStrategy.logDecision call site not found').toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(applyIdx);
  });
});

describe('AUDIT-IFleet-d3e66e4a: factory integration passes mode through to classifyTask', () => {
  // The above classifier test would still pass if factory.ts dropped mode on the
  // floor before invoking classifyTask. Lock the actual call site at the source
  // level so future refactors can't silently regress the integration.
  //
  // After the RoutingStrategy seam (T3 20260710-0617-phase1-extraction),
  // classifyTask is invoked through `routingStrategy.classify({...})` and mode
  // is threaded via `task.mode ?? undefined` (the strategy interface's
  // `mode?: string | undefined` shape) instead of the raw `task.mode`.
  it('factory.ts calls routingStrategy.classify with mode: task.mode', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    const call = src.match(/routingStrategy\.classify\(\{[\s\S]*?\}\)/);
    expect(call, 'routingStrategy.classify call not found in factory.ts').not.toBeNull();
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

describe('AUDIT-IFleet-123ca38b: buildWorkerPool forwards parentTraceId → LANGFUSE_PARENT_TRACE_ID', () => {
  const ADAPTER_NAME = 'fake-cli-pipeline-langfuse';
  const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-langfuse' });
  const resultLine = JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0 });

  const workerConfig: WorkerConfig = {
    id: 'claude-max-test',
    provider: 'claude',
    authProfile: 'default',
    models: ['claude-sonnet-4-6'],
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
  });

  afterAll(() => {
    delete process.env.IFLEET_ADAPTER;
    __resetPipelineAdapterRegistry();
    registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => createClaudeCliPipelineAdapter());
  });

  it('injects LANGFUSE_PARENT_TRACE_ID into child env when parentTraceId is passed to buildWorkerPool', async () => {
    const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
    registerPipelineAdapter(ADAPTER_NAME, () =>
      createClaudeCliPipelineAdapter({ inner: { spawnImpl: fake.spawn } }),
    );
    process.env.IFLEET_ADAPTER = ADAPTER_NAME;

    const wp = buildWorkerPool(workerConfig, undefined, 'trace-abc-123');
    const handle = wp.spawn(spec, 'brief', {
      role: 'editor',
      worktreePath: '/tmp/wt',
      abortSignal: new AbortController().signal,
    });
    await handle.result();

    const call = fake.calls[0];
    expect(call).toBeDefined();
    expect(call?.env?.['LANGFUSE_PARENT_TRACE_ID']).toBe('trace-abc-123');
  });

  it('LANGFUSE_PARENT_TRACE_ID absent from child env when no parentTraceId given', async () => {
    const fake = createFakeSpawn({ stdoutLines: [initLine, resultLine] });
    registerPipelineAdapter(ADAPTER_NAME, () =>
      createClaudeCliPipelineAdapter({ inner: { spawnImpl: fake.spawn } }),
    );
    process.env.IFLEET_ADAPTER = ADAPTER_NAME;
    const saved = process.env['LANGFUSE_PARENT_TRACE_ID'];
    delete process.env['LANGFUSE_PARENT_TRACE_ID'];
    try {
      const wp = buildWorkerPool(workerConfig);
      const handle = wp.spawn(spec, 'brief', {
        role: 'editor',
        worktreePath: '/tmp/wt',
        abortSignal: new AbortController().signal,
      });
      await handle.result();

      const call = fake.calls[0];
      expect(call).toBeDefined();
      expect(call?.env?.['LANGFUSE_PARENT_TRACE_ID']).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env['LANGFUSE_PARENT_TRACE_ID'] = saved;
    }
  });
});
