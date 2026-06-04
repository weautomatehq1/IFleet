/**
 * Cold-start integration test for backfill-pr-decisions (AUDIT-IFleet-31181042).
 *
 * Verifies that ensureBackfillTaskStub + recordPrDecision succeeds on a fresh
 * DB that has no pre-seeded tasks rows — the FK on pr_decisions.task_id
 * previously caused every backfill run against a new DB to throw.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TaskStore } from '../store.js';

describe('backfill-pr-decisions cold-start (AUDIT-IFleet-31181042)', () => {
  it('recordPrDecision on a fresh DB with unseen task_id throws without stub', () => {
    const store = new TaskStore(':memory:');
    try {
      assert.throws(
        () =>
          store.recordPrDecision({
            taskId: 'backfill:https://github.com/weautomatehq1/IFleet/pull/1',
            repo: 'weautomatehq1/IFleet',
            prNumber: 1,
            verdict: 'merged',
          }),
        /missing after INSERT|FOREIGN KEY/i,
        'expected FK-related error without a stub task row',
      );
    } finally {
      store.close();
    }
  });

  it('ensureBackfillTaskStub + recordPrDecision succeeds on a fresh DB', () => {
    const store = new TaskStore(':memory:');
    try {
      const taskId = 'backfill:https://github.com/weautomatehq1/IFleet/pull/42';
      const repo = 'weautomatehq1/IFleet';

      store.ensureBackfillTaskStub(taskId, repo);
      const row = store.recordPrDecision({ taskId, repo, prNumber: 42, verdict: 'merged' });

      assert.equal(row.taskId, taskId);
      assert.equal(row.prNumber, 42);
      assert.equal(row.verdict, 'merged');
      // Backfill does not set fingerprint — column exists but is null.
      assert.equal(row.fingerprint, null, 'fingerprint column exists and is null for backfill rows');

      const fetched = store.getPrDecisionByTaskPr(taskId, 42);
      assert.ok(fetched, 'row must be retrievable after insert');
      assert.equal(fetched?.verdict, 'merged');
    } finally {
      store.close();
    }
  });

  it('ensureBackfillTaskStub is idempotent — second call does not throw', () => {
    const store = new TaskStore(':memory:');
    try {
      const taskId = 'backfill:https://github.com/weautomatehq1/IFleet/pull/99';
      store.ensureBackfillTaskStub(taskId, 'weautomatehq1/IFleet');
      assert.doesNotThrow(() =>
        store.ensureBackfillTaskStub(taskId, 'weautomatehq1/IFleet'),
      );
    } finally {
      store.close();
    }
  });

  it('multiple backfill rows from different PRs succeed on a single fresh DB', () => {
    const store = new TaskStore(':memory:');
    try {
      const repo = 'weautomatehq1/IFleet';
      const pairs = [
        { prNumber: 10, url: 'https://github.com/weautomatehq1/IFleet/pull/10' },
        { prNumber: 11, url: 'https://github.com/weautomatehq1/IFleet/pull/11' },
        { prNumber: 12, url: 'https://github.com/weautomatehq1/IFleet/pull/12' },
      ];

      for (const { prNumber, url } of pairs) {
        const taskId = `backfill:${url}`;
        store.ensureBackfillTaskStub(taskId, repo);
        store.recordPrDecision({ taskId, repo, prNumber, verdict: 'abandoned' });
      }

      const rows = store.getPrDecisionsByRepo(repo, 100);
      assert.equal(rows.length, 3);
      assert.ok(
        rows.every((r) => r.fingerprint === null),
        'all backfill rows have null fingerprint',
      );
    } finally {
      store.close();
    }
  });
});
