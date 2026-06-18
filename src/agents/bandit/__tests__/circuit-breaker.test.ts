import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = Database.Database;

import {
  DEFAULT_CB_COOLDOWN,
  DEFAULT_CB_THRESHOLD,
  ensureCircuitBreakerSchema,
  getArmState,
  getCBCooldown,
  getCBThreshold,
  onAssignment,
  recordOutcome,
} from '../circuit-breaker.js';
import { resolveRoutingModel } from '../live.js';

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY);
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
  ensureCircuitBreakerSchema(db);
  return db;
}

const ACTUAL = '__live_routing_default__';
const KNOWN_ARMS = ['claude-opus-4-7', 'claude-sonnet-4-6'];
const OPUS = 'claude-opus-4-7';
const SONNET = 'claude-sonnet-4-6';

function baseInput() {
  return {
    taskId: 'task-1',
    repo: 'weautomatehq1/IFleet',
    decidedAt: 1_700_000_000_000,
    actualModel: ACTUAL,
    observations: [{ arm: OPUS, reward: 1 as const }],
    knownArms: KNOWN_ARMS,
    rng: seededRng(7),
    role: 'architect' as const,
  };
}

describe('circuit-breaker — env tunables', () => {
  it('reads BANDIT_CB_THRESHOLD / BANDIT_CB_COOLDOWN with documented defaults', () => {
    expect(getCBThreshold({} as NodeJS.ProcessEnv)).toBe(DEFAULT_CB_THRESHOLD);
    expect(getCBCooldown({} as NodeJS.ProcessEnv)).toBe(DEFAULT_CB_COOLDOWN);
    expect(getCBThreshold({ BANDIT_CB_THRESHOLD: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(getCBCooldown({ BANDIT_CB_COOLDOWN: '7' } as NodeJS.ProcessEnv)).toBe(7);
    expect(getCBThreshold({ BANDIT_CB_THRESHOLD: 'bogus' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_CB_THRESHOLD,
    );
    expect(getCBThreshold({ BANDIT_CB_THRESHOLD: '0' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_CB_THRESHOLD,
    );
  });
});

describe('circuit-breaker — 5 documented behaviors', () => {
  let db: DB;
  beforeEach(() => {
    db = makeDb();
  });

  it('OFF — BANDIT_LIVE off ⇒ no CB state is mutated', () => {
    // Run resolveRoutingModel many times with live=false. State must stay default.
    for (let i = 0; i < 10; i++) {
      const resolved = resolveRoutingModel(db, baseInput(), { live: false });
      expect(resolved.model).toBe(ACTUAL);
    }
    // Also try recording "failures" externally — but those go through recordOutcome,
    // and the OFF guarantee is specifically about the LIVE PATH not touching CB state.
    // Verify: no rows exist in bandit_arm_state.
    const rows = db.prepare(`SELECT * FROM bandit_arm_state`).all();
    expect(rows).toHaveLength(0);
    // And the public read returns clean defaults for any arm.
    expect(getArmState(db, OPUS)).toMatchObject({
      arm: OPUS,
      status: 'active',
      consecutiveFailures: 0,
      assignmentsRemaining: 0,
    });
  });

  it('trip — N consecutive failures (default 5) disable the arm with a full cooldown window', () => {
    for (let i = 0; i < DEFAULT_CB_THRESHOLD - 1; i++) {
      const s = recordOutcome(db, OPUS, false, { now: 100 + i });
      expect(s.status).toBe('active');
      expect(s.consecutiveFailures).toBe(i + 1);
    }
    // The Nth failure trips the breaker.
    const tripped = recordOutcome(db, OPUS, false, { now: 200 });
    expect(tripped.status).toBe('disabled');
    expect(tripped.consecutiveFailures).toBe(DEFAULT_CB_THRESHOLD);
    expect(tripped.assignmentsRemaining).toBe(DEFAULT_CB_COOLDOWN);

    // A success BEFORE the trip should have reset the counter — proves the
    // "consecutive" semantic (vs. cumulative).
    const db2 = makeDb();
    recordOutcome(db2, OPUS, false, { now: 1 });
    recordOutcome(db2, OPUS, false, { now: 2 });
    recordOutcome(db2, OPUS, true, { now: 3 }); // reset
    for (let i = 0; i < DEFAULT_CB_THRESHOLD - 1; i++) {
      const s = recordOutcome(db2, OPUS, false, { now: 10 + i });
      expect(s.status).toBe('active'); // not yet
    }
    expect(getArmState(db2, OPUS).consecutiveFailures).toBe(DEFAULT_CB_THRESHOLD - 1);
  });

  it('suppress — a disabled arm gets vetoed; live path falls back to canonical (actualModel)', () => {
    // Disable BOTH known arms so whichever the sampler picks, the CB suppresses it.
    for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) recordOutcome(db, OPUS, false);
    for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) recordOutcome(db, SONNET, false);
    expect(getArmState(db, OPUS).status).toBe('disabled');
    expect(getArmState(db, SONNET).status).toBe('disabled');

    const resolved = resolveRoutingModel(db, baseInput(), { live: true });
    expect(resolved.suppressed).toBe(true);
    expect(resolved.overridden).toBe(false);
    expect(resolved.model).toBe(ACTUAL); // canonical fallback
    // Shadow row STILL recorded — the read-only shadow path is untouched.
    expect(resolved.record).not.toBeNull();
  });

  it('probe-success — after the cooldown elapses, a single probe + success re-enables the arm', () => {
    // Trip OPUS.
    for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) recordOutcome(db, OPUS, false);
    expect(getArmState(db, OPUS).status).toBe('disabled');
    expect(getArmState(db, OPUS).assignmentsRemaining).toBe(DEFAULT_CB_COOLDOWN);

    // Burn through the cooldown window by simulating assignments. We call
    // onAssignment directly here (the live path does this internally).
    for (let i = 0; i < DEFAULT_CB_COOLDOWN; i++) {
      onAssignment(db, KNOWN_ARMS, { now: 1000 + i });
    }
    const after = getArmState(db, OPUS);
    expect(after.status).toBe('probing');
    expect(after.assignmentsRemaining).toBe(0);

    // Probe success → arm re-enabled, failure counter reset.
    const reenabled = recordOutcome(db, OPUS, true, { now: 2000 });
    expect(reenabled.status).toBe('active');
    expect(reenabled.consecutiveFailures).toBe(0);
    expect(reenabled.assignmentsRemaining).toBe(0);
  });

  it('probe-fail — a probe failure puts the arm straight back into disabled with a fresh cooldown', () => {
    for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) recordOutcome(db, OPUS, false);
    for (let i = 0; i < DEFAULT_CB_COOLDOWN; i++) {
      onAssignment(db, KNOWN_ARMS, { now: 1000 + i });
    }
    expect(getArmState(db, OPUS).status).toBe('probing');

    const refailed = recordOutcome(db, OPUS, false, { now: 3000 });
    expect(refailed.status).toBe('disabled');
    expect(refailed.assignmentsRemaining).toBe(DEFAULT_CB_COOLDOWN);
    // Same trip → counter still climbs (consecutive failures across the
    // probe attempt are still "consecutive" — the success reset never happened).
    expect(refailed.consecutiveFailures).toBeGreaterThanOrEqual(DEFAULT_CB_THRESHOLD + 1);
  });
});
