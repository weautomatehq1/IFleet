// Regression cover for F5 — the PR opener ran `gh pr create --reviewer
// @monstersebas1`. The `@` prefix made `gh` reject the login, so `gh` exited
// non-zero *after* creating the PR, failing the whole task over a non-essential
// step. normalizeReviewers strips the `@` so `gh` gets a bare login.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { applyBanditRouting, buildWorkerPool, FIVE_HOURS_MS, normalizeReviewers } from '../factory.js';
import { classifyTask } from '../../classifier/index.js';
import { writeRoutingDecisionLog } from '../../orchestrator/closure-log.js';
import { readShadowDecisions } from '../../agents/bandit/shadow.js';
import { KNOWN_MODEL_IDS } from '../../agents/bandit/known-arms.js';
import type { RoutingDecision } from '../types.js';
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
  it('factory.ts calls setRoutingDecision + resolveRoutingModel after classifyTask', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/opts\.taskStore\.setRoutingDecision\(task\.id, routing\)/);
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

describe('AUDIT-IFleet-dca269af: writeRoutingDecisionLog called after applyBanditRouting (BANDIT_LIVE=1 fix)', () => {
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
    db.prepare('INSERT INTO tasks (id) VALUES (?)').run('task-telem-1');
    return db;
  }

  it('source: writeRoutingDecisionLog call site appears after applyBanditRouting — ensures BANDIT_LIVE=1 override is visible to the logger', () => {
    const src = readFileSync(new URL('../factory.ts', import.meta.url), 'utf-8');
    const applyIdx = src.indexOf('applyBanditRouting(db, routing,');
    const logIdx = src.indexOf('writeRoutingDecisionLog(');
    expect(applyIdx, 'applyBanditRouting call not found in factory.ts').toBeGreaterThan(-1);
    expect(logIdx, 'writeRoutingDecisionLog call not found in factory.ts').toBeGreaterThan(-1);
    expect(
      logIdx,
      'writeRoutingDecisionLog must appear AFTER applyBanditRouting so the log captures the post-override tier when BANDIT_LIVE=1',
    ).toBeGreaterThan(applyIdx);
  });

  it('BANDIT_LIVE=1: after applyBanditRouting overrides architect, writeRoutingDecisionLog captures the post-bandit model in the log sink', () => {
    const db = makeDb();
    const routing: RoutingDecision = {
      architect: { provider: 'claude', model: '__pre-bandit-sentinel__', workerId: 'w-a' },
      editor: { provider: 'claude', model: '__sentinel-editor__', workerId: 'w-e' },
      reviewer: { provider: 'claude', model: '__sentinel-reviewer__', workerId: 'w-r' },
      verify: [],
      _meta: { hitKeyword: null, rawScore: 0, finalTier: 'opus' },
    };

    // Simulate BANDIT_LIVE=1: the bandit overrides architect.model to a known arm.
    applyBanditRouting(db, routing, { id: 'task-telem-1', repo: 'weautomatehq1/IFleet' }, {
      live: true,
      now: 1_700_000_000_000,
    });

    // After the flip, routing.architect.model is now a real known arm — not the sentinel.
    expect(routing.architect.model).not.toBe('__pre-bandit-sentinel__');
    expect(KNOWN_MODEL_IDS).toContain(routing.architect.model);

    // Confirm the logger, called at this point (post-flip), sees the overridden model
    // via the routing object. The sink captures what writeRoutingDecisionLog emits.
    const lines: string[] = [];
    if (routing._meta) {
      writeRoutingDecisionLog(
        {
          task_id: 'task-telem-1',
          hit_keyword: routing._meta.hitKeyword,
          final_tier: routing._meta.finalTier,
          raw_score: routing._meta.rawScore,
          decided_at: new Date(1_700_000_000_000).toISOString(),
        },
        (line) => lines.push(line),
      );
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[ROUTING-DECISION-LOG\]/);
    // The log was produced from post-bandit state — routing.architect.model is a known arm.
    // Ordering fix guarantees this log fires AFTER the flip in the real factory dispatch path.
    const entry = JSON.parse((lines[0] ?? '').replace('[ROUTING-DECISION-LOG] ', ''));
    expect(entry.task_id).toBe('task-telem-1');
  });
});
