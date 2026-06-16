import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = Database.Database;

import { readShadowDecisions, recordShadowDecision } from '../shadow.js';

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeDb(): DB {
  // In-memory sqlite — tests don't touch the repo's tasks.db.
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
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);
  db.prepare('INSERT INTO tasks (id) VALUES (?)').run('task-1');
  db.prepare('INSERT INTO tasks (id) VALUES (?)').run('task-2');
  return db;
}

describe('recordShadowDecision', () => {
  let db: DB;
  beforeEach(() => {
    db = makeDb();
  });

  it('persists one row per decision with snapshots and shadow_model populated', () => {
    const rec = recordShadowDecision(db, {
      taskId: 'task-1',
      repo: 'weautomatehq1/IFleet',
      decidedAt: 1_700_000_000_000,
      actualModel: 'claude-sonnet-4-6',
      observations: [
        { arm: 'claude-opus-4-7', reward: 1 },
        { arm: 'claude-opus-4-7', reward: 1 },
        { arm: 'claude-sonnet-4-6', reward: 0 },
      ],
      knownArms: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      rng: seededRng(7),
    });
    expect(rec).not.toBeNull();
    expect(rec!.shadowModel).toMatch(/claude-/);
    expect(rec!.posteriors.find((p) => p.arm === 'claude-opus-4-7')).toEqual({
      arm: 'claude-opus-4-7',
      alpha: 3,
      beta: 1,
    });
    const rows = readShadowDecisions(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe('task-1');
    expect(rows[0]!.actualModel).toBe('claude-sonnet-4-6');
    expect(rows[0]!.shadowModel).toBe(rec!.shadowModel);
    expect(rows[0]!.alphaSnapshot['claude-opus-4-7']).toBe(3);
  });

  it('does NOT touch the actual_model — the live routing decision is preserved verbatim', () => {
    const actual = 'claude-haiku-4-5-20251001';
    const rec = recordShadowDecision(db, {
      taskId: 'task-2',
      repo: 'weautomatehq1/IFleet',
      decidedAt: 1_700_000_000_001,
      actualModel: actual,
      observations: [{ arm: 'claude-opus-4-7', reward: 1 }],
      knownArms: ['claude-opus-4-7', 'claude-haiku-4-5-20251001'],
      rng: seededRng(11),
    });
    expect(rec).not.toBeNull();
    expect(rec!.actualModel).toBe(actual);
  });

  it('throws on knownArms=[] — no fallback to a default arm set', () => {
    expect(() =>
      recordShadowDecision(db, {
        taskId: 'task-1',
        repo: 'r',
        decidedAt: 1,
        actualModel: 'x',
        observations: [],
        knownArms: [],
      }),
    ).toThrow(/≥1 knownArm/);
  });

  it('cascades on tasks delete — orphaned shadow rows are removed via FK', () => {
    recordShadowDecision(db, {
      taskId: 'task-1',
      repo: 'r',
      decidedAt: 1,
      actualModel: 'claude-sonnet-4-6',
      observations: [],
      knownArms: ['claude-sonnet-4-6'],
      rng: seededRng(1),
    });
    db.prepare('DELETE FROM tasks WHERE id = ?').run('task-1');
    expect(readShadowDecisions(db).filter((r) => r.taskId === 'task-1')).toHaveLength(0);
  });

  it('returns null + warns when the SQLite write fails (fail-open, does not throw)', () => {
    // Stand-in DB whose .prepare throws — simulates a missing table or a
    // disk-full state at the moment the bandit goes to write. The
    // routing path must NOT see this error bubble up.
    const brokenDb = {
      prepare: () => {
        throw new Error('no such table: routing_shadow_log');
      },
    } as unknown as DB;
    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const result = recordShadowDecision(brokenDb, {
        taskId: 'task-x',
        repo: 'r',
        decidedAt: 1,
        actualModel: 'claude-sonnet-4-6',
        observations: [],
        knownArms: ['claude-sonnet-4-6'],
        rng: seededRng(1),
      });
      expect(result).toBeNull();
      expect(warns.some((w) => /recordShadowDecision failed/.test(w))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('readShadowDecisions', () => {
  it('returns rows newest first', () => {
    const db = makeDb();
    recordShadowDecision(db, {
      taskId: 'task-1',
      repo: 'r',
      decidedAt: 1_000,
      actualModel: 'claude-sonnet-4-6',
      observations: [],
      knownArms: ['claude-sonnet-4-6'],
      rng: seededRng(1),
    });
    recordShadowDecision(db, {
      taskId: 'task-2',
      repo: 'r',
      decidedAt: 2_000,
      actualModel: 'claude-sonnet-4-6',
      observations: [],
      knownArms: ['claude-sonnet-4-6'],
      rng: seededRng(2),
    });
    const rows = readShadowDecisions(db);
    expect(rows[0]!.taskId).toBe('task-2');
    expect(rows[1]!.taskId).toBe('task-1');
  });
});
