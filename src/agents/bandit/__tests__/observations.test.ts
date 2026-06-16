import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

type DB = Database.Database;

import { buildShadowObservations } from '../observations.js';

function makeDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal schema mirroring what TaskStore exposes — the reader only needs
  // tasks.id + tasks.routing_decision and pr_decisions.task_id/repo/verdict.
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      routing_decision TEXT
    );
    CREATE TABLE pr_decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      verdict TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function seedTask(db: DB, id: string, decision: unknown | null): void {
  db.prepare(`INSERT INTO tasks (id, routing_decision) VALUES (?, ?)`).run(
    id,
    decision === null ? null : JSON.stringify(decision),
  );
}

function seedPr(db: DB, id: string, taskId: string, repo: string, verdict: string): void {
  db.prepare(
    `INSERT INTO pr_decisions (id, task_id, repo, verdict) VALUES (?, ?, ?, ?)`,
  ).run(id, taskId, repo, verdict);
}

describe('buildShadowObservations', () => {
  let db: DB;
  beforeEach(() => {
    db = makeDb();
  });

  it('maps merged → 1, rejected → 0; skips abandoned', () => {
    const routing = {
      architect: { model: 'claude-opus-4-7' },
      editor: { model: 'claude-sonnet-4-6' },
      reviewer: { model: 'claude-sonnet-4-6' },
    };
    seedTask(db, 't1', routing);
    seedTask(db, 't2', routing);
    seedTask(db, 't3', routing);
    seedPr(db, 'p1', 't1', 'org/repo', 'merged');
    seedPr(db, 'p2', 't2', 'org/repo', 'rejected');
    seedPr(db, 'p3', 't3', 'org/repo', 'abandoned');

    const obs = buildShadowObservations(db, 'org/repo', 'architect');
    expect(obs).toHaveLength(2);
    expect(obs).toContainEqual({ arm: 'claude-opus-4-7', reward: 1 });
    expect(obs).toContainEqual({ arm: 'claude-opus-4-7', reward: 0 });
  });

  it('filters out tasks with NULL routing_decision (pre-M6 history)', () => {
    seedTask(db, 'tNull', null);
    seedPr(db, 'pNull', 'tNull', 'org/repo', 'merged');
    expect(buildShadowObservations(db, 'org/repo', 'architect')).toEqual([]);
  });

  it('reads per-role: architect vs editor return distinct arm sets', () => {
    seedTask(db, 't1', {
      architect: { model: 'claude-opus-4-7' },
      editor: { model: 'claude-sonnet-4-6' },
      reviewer: { model: 'claude-sonnet-4-6' },
    });
    seedPr(db, 'p1', 't1', 'org/repo', 'merged');

    expect(buildShadowObservations(db, 'org/repo', 'architect')).toEqual([
      { arm: 'claude-opus-4-7', reward: 1 },
    ]);
    expect(buildShadowObservations(db, 'org/repo', 'editor')).toEqual([
      { arm: 'claude-sonnet-4-6', reward: 1 },
    ]);
  });

  it('filters out malformed routing_decision (missing role.model)', () => {
    // Architect path absent entirely — json_extract → NULL.
    seedTask(db, 'tBad', { editor: { model: 'x' } });
    seedPr(db, 'pBad', 'tBad', 'org/repo', 'merged');
    expect(buildShadowObservations(db, 'org/repo', 'architect')).toEqual([]);
  });

  it('filters by repo — observations from other repos are not returned', () => {
    seedTask(db, 't1', { architect: { model: 'claude-opus-4-7' } });
    seedTask(db, 't2', { architect: { model: 'claude-opus-4-7' } });
    seedPr(db, 'p1', 't1', 'org/A', 'merged');
    seedPr(db, 'p2', 't2', 'org/B', 'merged');
    const obsA = buildShadowObservations(db, 'org/A', 'architect');
    expect(obsA).toEqual([{ arm: 'claude-opus-4-7', reward: 1 }]);
  });

  it('rejects unknown roles at runtime (defence-in-depth on the JSON path)', () => {
    expect(() =>
      buildShadowObservations(db, 'org/repo', 'doctor' as unknown as 'architect'),
    ).toThrow(/unknown role/i);
  });
});
