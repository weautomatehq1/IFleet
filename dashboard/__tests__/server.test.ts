import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listPrDecisions } from '../server.js';

describe('dashboard server', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pr_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        reviewer_login TEXT,
        merged_at INTEGER,
        created_at INTEGER NOT NULL,
        fingerprint TEXT
      );
      INSERT INTO pr_decisions (id, task_id, repo, pr_number, verdict, reviewer_login, created_at)
      VALUES ('pr1', 'task1', 'repo1', 123, 'approved', 'reviewer1', 1000);
    `);
  });

  afterAll(() => {
    db.close();
  });

  it('listPrDecisions returns rows with correct mapping', () => {
    const results = listPrDecisions(db, 20);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: 'pr1',
      taskId: 'task1',
      repo: 'repo1',
      prNumber: 123,
      verdict: 'approved',
      reviewerLogin: 'reviewer1',
      createdAt: 1000,
    });
  });
});
