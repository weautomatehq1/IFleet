import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { QueuedTask } from '@wahq/orchestrator-core/contracts/task';
import { ulid } from '@wahq/orchestrator-core/utils/ulid';

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-fp-store-'));
  const path = join(dir, 'tasks.db');
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedTask(store: TaskStore, idempotencyKey: string): QueuedTask {
  const task: QueuedTask = {
    id: ulid(),
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: 'I_kw1',
      url: 'https://github.com/weautomatehq1/IFleet/issues/1',
    },
    repo: 'weautomatehq1/IFleet',
    brief: 'do thing',
    title: 'do thing',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey,
    state: 'pending',
  };
  store.insert(task);
  return task;
}

describe('pr_decisions.fingerprint (M4-T1/T2)', () => {
  it('insertPrDecisionWithFingerprint round-trips fingerprint via SELECT', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = seedTask(store, 'gh:M4-roundtrip');
      const fingerprint = 'a'.repeat(64);
      const row = store.insertPrDecisionWithFingerprint({
        id: `prd_${ulid()}`,
        taskId: task.id,
        repo: task.repo,
        prNumber: 101,
        verdict: 'merged',
        reviewerLogin: 'sebas',
        mergedAt: Date.now(),
        fingerprint,
      });
      assert.equal(row.fingerprint, fingerprint);

      const fetched = store.getPrDecisionByTaskPr(task.id, 101);
      assert.ok(fetched);
      assert.equal(fetched?.fingerprint, fingerprint);
      assert.equal(fetched?.verdict, 'merged');
      assert.equal(fetched?.reviewerLogin, 'sebas');

      store.close();
    } finally {
      cleanup();
    }
  });

  it('insertPrDecisionWithFingerprint accepts a null fingerprint', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = seedTask(store, 'gh:M4-null-fp');
      const row = store.insertPrDecisionWithFingerprint({
        id: `prd_${ulid()}`,
        taskId: task.id,
        repo: task.repo,
        prNumber: 102,
        verdict: 'rejected',
      });
      assert.equal(row.fingerprint, null);
      assert.equal(row.reviewerLogin, null);
      assert.equal(row.mergedAt, null);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('is idempotent on (task_id, pr_number) — second insert returns existing row', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = seedTask(store, 'gh:M4-idempotent');
      const id1 = `prd_${ulid()}`;
      const first = store.insertPrDecisionWithFingerprint({
        id: id1,
        taskId: task.id,
        repo: task.repo,
        prNumber: 103,
        verdict: 'merged',
        fingerprint: 'first-hash',
      });
      const second = store.insertPrDecisionWithFingerprint({
        id: `prd_${ulid()}`,
        taskId: task.id,
        repo: task.repo,
        prNumber: 103,
        verdict: 'rejected',
        fingerprint: 'second-hash-ignored',
      });
      // INSERT OR IGNORE — second call returns the original row unchanged.
      assert.equal(second.id, first.id);
      assert.equal(second.fingerprint, 'first-hash');
      assert.equal(second.verdict, 'merged');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('migration is idempotent — opening the same DB twice does not error and column exists once', () => {
    const { path, cleanup } = tmpDb();
    try {
      const first = new TaskStore(path);
      first.close();
      const second = new TaskStore(path);
      second.close();

      const raw = new Database(path);
      try {
        const cols = raw.pragma('table_info(pr_decisions)') as Array<{ name: string }>;
        const fp = cols.filter((c) => c.name === 'fingerprint');
        assert.equal(fp.length, 1, 'fingerprint column should exist exactly once');
      } finally {
        raw.close();
      }
    } finally {
      cleanup();
    }
  });

  it('upgrades a pre-M4 DB in place: existing row gets a fingerprint column with NULL', () => {
    const { path, cleanup } = tmpDb();
    try {
      // Simulate a pre-M4 DB: create pr_decisions without the fingerprint
      // column and stash an existing row. This proves the ALTER preserves
      // history and that historical NULLs round-trip cleanly.
      const raw = new Database(path);
      raw.exec(`
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
          priority TEXT NOT NULL DEFAULT 'normal',
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE pr_decisions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          verdict TEXT NOT NULL,
          reviewer_login TEXT,
          merged_at INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        INSERT INTO tasks (id, source_kind, source_data, repo, brief, title, routing_hints,
                           state, idempotency_key, created_at)
        VALUES ('t1', 'github', '{}', 'weautomatehq1/IFleet', 'b', 't', '{}', 'done', 'k1', 1);
        INSERT INTO pr_decisions (id, task_id, repo, pr_number, verdict, reviewer_login,
                                  merged_at, created_at)
        VALUES ('prd_legacy', 't1', 'weautomatehq1/IFleet', 999, 'merged', 'old', 1, 1);
      `);
      raw.close();

      // Opening with TaskStore runs the M4 ALTER.
      const store = new TaskStore(path);
      const legacy = store.getPrDecisionByTaskPr('t1', 999);
      assert.ok(legacy);
      assert.equal(legacy?.fingerprint, null);
      store.close();
    } finally {
      cleanup();
    }
  });
});
