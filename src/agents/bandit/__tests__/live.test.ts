import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = Database.Database;

import { banditLiveEnabled, resolveRoutingModel } from '../live.js';
import { readShadowDecisions } from '../shadow.js';

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
  return db;
}

// actualModel is a sentinel that is NOT a known arm — so the sampled shadow
// arm can never coincidentally equal it. Override is then provable for ANY
// rng/seed: shadowModel ∈ knownArms, actualModel ∉ knownArms ⇒ they differ.
const ACTUAL = '__live_routing_default__';
const KNOWN_ARMS = ['claude-opus-4-7', 'claude-sonnet-4-6'];

function baseInput() {
  return {
    taskId: 'task-1',
    repo: 'weautomatehq1/IFleet',
    decidedAt: 1_700_000_000_000,
    actualModel: ACTUAL,
    observations: [{ arm: 'claude-opus-4-7', reward: 1 as const }],
    knownArms: KNOWN_ARMS,
    rng: seededRng(7),
    role: 'architect' as const,
  };
}

describe('banditLiveEnabled', () => {
  it('reads "1"/"true" as on, everything else as off', () => {
    expect(banditLiveEnabled({ BANDIT_LIVE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(banditLiveEnabled({ BANDIT_LIVE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(banditLiveEnabled({ BANDIT_LIVE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(banditLiveEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('resolveRoutingModel — BANDIT_LIVE flag', () => {
  let db: DB;
  beforeEach(() => {
    db = makeDb();
  });

  it('(a) flag OFF ⇒ shadow-only: model stays the live actualModel, but the shadow row is still written', () => {
    const resolved = resolveRoutingModel(db, baseInput(), { live: false });

    // Live decision untouched.
    expect(resolved.model).toBe(ACTUAL);
    expect(resolved.actualModel).toBe(ACTUAL);
    expect(resolved.overridden).toBe(false);

    // Shadow logging still happened (#370 behavior preserved).
    expect(resolved.record).not.toBeNull();
    expect(resolved.shadowModel).toBe(resolved.record!.shadowModel);
    const rows = readShadowDecisions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualModel).toBe(ACTUAL);
  });

  it('(b) flag ON ⇒ the sampled arm becomes the actual routing decision', () => {
    const resolved = resolveRoutingModel(db, baseInput(), { live: true });

    // The model the caller routes to IS the sampled shadow arm...
    expect(resolved.model).toBe(resolved.record!.shadowModel);
    // ...which is one of the known arms, never the sentinel live default.
    expect(KNOWN_ARMS).toContain(resolved.model);
    expect(resolved.model).not.toBe(ACTUAL);
    expect(resolved.overridden).toBe(true);

    // Shadow row still records the ORIGINAL live decision for analytics.
    const rows = readShadowDecisions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actualModel).toBe(ACTUAL);
    expect(rows[0]!.shadowModel).toBe(resolved.model);
  });

  it('never overrides when the shadow write fails (fail-safe: live decision wins)', () => {
    const brokenDb = {
      prepare: () => {
        throw new Error('no such table: routing_shadow_log');
      },
    } as unknown as DB;
    const resolved = resolveRoutingModel(brokenDb, baseInput(), { live: true });
    expect(resolved.record).toBeNull();
    expect(resolved.model).toBe(ACTUAL);
    expect(resolved.overridden).toBe(false);
  });
});
