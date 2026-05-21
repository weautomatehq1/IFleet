import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createDashboardServer, openDashboardDbs } from './server';

/**
 * Build minimal fixtures of both schemas so the test never touches the
 * developer's real ~/.omc/ifleet/state.db or ./state/tasks.db.
 */
function seedTasksDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_data TEXT NOT NULL,
      repo TEXT NOT NULL,
      brief TEXT NOT NULL,
      title TEXT NOT NULL,
      routing_hints TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      state_meta TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      picked_at INTEGER,
      completed_at INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE pr_decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      reviewer_login TEXT,
      merged_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO tasks (id, source_kind, source_data, repo, brief, title, routing_hints,
                       state, idempotency_key, created_at, priority, picked_at)
    VALUES (@id, @sk, '{}', @repo, @brief, @title, '{}', @state, @idem, @created, @priority, @picked)
  `);
  insert.run({ id: 't-pending', sk: 'github', repo: 'org/a', brief: 'b', title: 'pending task',
    state: 'pending', idem: 'k1', created: now - 1000, priority: 'high', picked: null });
  insert.run({ id: 't-in-flight', sk: 'discord', repo: 'org/b', brief: 'b', title: 'in flight task',
    state: 'in_flight', idem: 'k2', created: now - 2000, priority: 'normal', picked: now - 500 });
  insert.run({ id: 't-done', sk: 'github', repo: 'org/a', brief: 'b', title: 'done task',
    state: 'done', idem: 'k3', created: now - 3000, priority: 'normal', picked: now - 2500 });
  db.close();
}

function seedStateDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      goal TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE pr_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER,
      verdict TEXT NOT NULL,
      reviewer_login TEXT,
      decided_at INTEGER NOT NULL
    );
    CREATE TABLE sprint_runtime_state (
      sprint_id TEXT PRIMARY KEY,
      spent_usd REAL NOT NULL DEFAULT 0,
      rate_reset_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sprints (id, mode, goal, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sp-running', 'normal', 'do a thing', JSON.stringify({ kind: 'running' }), now - 5000, now - 100);
  db.prepare(
    `INSERT INTO sprints (id, mode, goal, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sp-failed', 'normal', 'old', JSON.stringify({ kind: 'failed' }), now - 10000, now - 9000);

  db.prepare(
    `INSERT INTO pr_decisions (task_id, repo, pr_number, verdict, reviewer_login, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('t-1', 'org/a', 42, 'merged', 'seb', now - 100);
  db.prepare(
    `INSERT INTO pr_decisions (task_id, repo, pr_number, verdict, reviewer_login, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('t-2', 'org/a', null, 'abandoned', null, now - 200);

  db.prepare(
    `INSERT INTO sprint_runtime_state (sprint_id, spent_usd, rate_reset_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run('sp-running', 1.2345, null, now);
  db.close();
}

describe('dashboard/server', () => {
  let tmp: string;
  let tasksDbPath: string;
  let stateDbPath: string;
  let handles: ReturnType<typeof createDashboardServer>;
  let baseUrl: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ifleet-dashboard-'));
    tasksDbPath = join(tmp, 'tasks.db');
    stateDbPath = join(tmp, 'state.db');
    seedTasksDb(tasksDbPath);
    seedStateDb(stateDbPath);

    handles = createDashboardServer({ tasksDbPath, stateDbPath });
    await new Promise<void>((resolve) => handles.server.listen(0, '127.0.0.1', resolve));
    const addr = handles.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await handles.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('opens both databases in readonly mode', () => {
    const { tasksDb, stateDb } = openDashboardDbs({ tasksDbPath, stateDbPath });
    try {
      expect(tasksDb.readonly).toBe(true);
      expect(stateDb.readonly).toBe(true);
      expect(() =>
        tasksDb.exec(`INSERT INTO tasks (id, source_kind, source_data, repo, brief, title,
          routing_hints, state, idempotency_key, created_at, priority)
          VALUES ('x', 'x', '{}', 'x', 'x', 'x', '{}', 'pending', 'xx', 0, 'normal')`),
      ).toThrow();
    } finally {
      tasksDb.close();
      stateDb.close();
    }
  });

  it('serves the index html at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('IFleet');
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('GET /api/health does NOT leak filesystem paths (post-audit regression)', async () => {
    // Earlier shape `{ ok, tasksDb, stateDb }` leaked absolute paths
    // like `/Users/<name>/.omc/ifleet/state.db` to any client that could
    // reach the server — including any browser tab on the same machine.
    // Health must stay minimal.
    const res = await fetch(`${baseUrl}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['ok']);
    expect(body['tasksDb']).toBeUndefined();
    expect(body['stateDb']).toBeUndefined();
  });

  it('GET /api/sprints/active filters out terminal sprints', async () => {
    const res = await fetch(`${baseUrl}/api/sprints/active`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string; kind: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('sp-running');
    expect(rows[0]?.kind).toBe('running');
  });

  it('GET /api/tasks/queue returns pending + in_flight, in_flight first', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/queue`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string; state: string }>;
    expect(rows.map((r) => r.state)).toEqual(['in_flight', 'pending']);
    expect(rows.find((r) => r.id === 't-done')).toBeUndefined();
  });

  it('GET /api/pr-decisions returns rows from StateStore newest first', async () => {
    const res = await fetch(`${baseUrl}/api/pr-decisions?limit=10`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ taskId: string; verdict: string; prNumber: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.taskId).toBe('t-1');
    expect(rows[0]?.prNumber).toBe(42);
    expect(rows[1]?.prNumber).toBeNull();
  });

  it('GET /api/budget returns sprint_runtime_state rows', async () => {
    const res = await fetch(`${baseUrl}/api/budget`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ sprintId: string; spentUsd: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sprintId).toBe('sp-running');
    expect(rows[0]?.spentUsd).toBeCloseTo(1.2345, 4);
  });

  it('returns 404 on unknown paths', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
