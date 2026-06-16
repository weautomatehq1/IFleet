import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import {
  countPendingProposals,
  extractProposalIdFromIdempotencyKey,
  recordProposalDecision,
  setResultingPrOutcome,
  setResultingTaskId,
} from '../goal-proposals-store.js';

function makePool(opts: { rowCount?: number; throws?: boolean } = {}) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      if (opts.throws) throw new Error('boom');
      return { rowCount: opts.rowCount ?? 1, rows: [] as unknown[] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

function makeMultiPool(responses: Array<{ rowCount: number; rows?: unknown[] }>) {
  let idx = 0;
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      const r = responses[idx++] ?? { rowCount: 0, rows: [] };
      return { rowCount: r.rowCount, rows: r.rows ?? [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('extractProposalIdFromIdempotencyKey: extracts id from proposal:<id>', () => {
  assert.equal(extractProposalIdFromIdempotencyKey('proposal:abc123'), 'abc123');
});

test('extractProposalIdFromIdempotencyKey: returns null for Discord key', () => {
  assert.equal(extractProposalIdFromIdempotencyKey('discord:1234:5678'), null);
});

test('extractProposalIdFromIdempotencyKey: returns null for null/undefined/empty', () => {
  assert.equal(extractProposalIdFromIdempotencyKey(null), null);
  assert.equal(extractProposalIdFromIdempotencyKey(undefined), null);
  assert.equal(extractProposalIdFromIdempotencyKey(''), null);
});

test('extractProposalIdFromIdempotencyKey: returns null for malformed keys', () => {
  assert.equal(extractProposalIdFromIdempotencyKey('proposal:abc/123'), null);
  assert.equal(extractProposalIdFromIdempotencyKey('proposal:'), null);
});

test('extractProposalIdFromIdempotencyKey: accepts UUID-shaped ids', () => {
  assert.equal(
    extractProposalIdFromIdempotencyKey('proposal:0c2a8a6e-1a3b-4f00-9e1d-8e3f6c5b4321'),
    '0c2a8a6e-1a3b-4f00-9e1d-8e3f6c5b4321',
  );
});

test('setResultingTaskId: writes task id and reports updated=true on row match', async () => {
  const { pool, calls } = makePool({ rowCount: 1 });
  const result = await setResultingTaskId('p-1', 'task-7', pool);
  assert.equal(result.updated, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /UPDATE goal_proposals/);
  assert.match(calls[0]!.text, /SET resulting_task_id/);
  assert.deepEqual(calls[0]!.params, ['p-1', 'task-7']);
});

test('setResultingTaskId: reports updated=false when proposal row missing', async () => {
  const { pool } = makePool({ rowCount: 0 });
  const result = await setResultingTaskId('missing', 'task-7', pool);
  assert.equal(result.updated, false);
});

test('setResultingPrOutcome: writes pr_url + pr_outcome for merged path', async () => {
  const { pool, calls } = makePool({ rowCount: 1 });
  const result = await setResultingPrOutcome(
    'p-1',
    'https://github.com/weautomatehq1/IFleet/pull/999',
    'merged',
    pool,
  );
  assert.equal(result.updated, true);
  assert.match(calls[0]!.text, /SET resulting_pr_url/);
  assert.match(calls[0]!.text, /resulting_pr_outcome/);
  assert.deepEqual(calls[0]!.params, [
    'p-1',
    'https://github.com/weautomatehq1/IFleet/pull/999',
    'merged',
  ]);
});

test('setResultingPrOutcome: accepts closed_unmerged for failed/cancelled path', async () => {
  const { pool, calls } = makePool({ rowCount: 1 });
  await setResultingPrOutcome('p-2', 'https://github.com/x/y/pull/1', 'closed_unmerged', pool);
  assert.equal(calls[0]!.params[2], 'closed_unmerged');
});

test('setResultingPrOutcome: reports updated=false when proposal row missing', async () => {
  const { pool } = makePool({ rowCount: 0 });
  const result = await setResultingPrOutcome('missing', 'https://x/y/pull/1', 'merged', pool);
  assert.equal(result.updated, false);
});

test('first-write-wins: second decision on a decided row returns updated:false and existing_decision', async () => {
  const { pool, calls } = makeMultiPool([
    { rowCount: 0 },                                        // UPDATE: blocked (already decided)
    { rowCount: 1, rows: [{ decision: 'approved' }] },      // SELECT: found the row
  ]);
  const result = await recordProposalDecision(
    { proposalId: 'p-10', decision: 'rejected', decidedBy: 'u-2' },
    pool,
  );
  assert.equal(result.updated, false);
  assert.equal(result.existing_decision, 'approved');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.text, /AND decision IS NULL/);
});

test('Approve does NOT reset resulting_task_id when row is already approved (rowCount 0)', async () => {
  const { pool, calls } = makeMultiPool([
    { rowCount: 0 },                                        // UPDATE: blocked by guard
    { rowCount: 1, rows: [{ decision: 'approved' }] },      // SELECT: row exists
  ]);
  const result = await recordProposalDecision(
    { proposalId: 'p-11', decision: 'approved', decidedBy: 'u-1' },
    pool,
  );
  assert.equal(result.updated, false);
  assert.equal(result.existing_decision, 'approved');
  // No third query — resulting_task_id is not touched when the guard blocks
  assert.equal(calls.length, 2);
});

test('Reject on an already-Approved row returns updated:false + existing_decision:approved', async () => {
  const { pool } = makeMultiPool([
    { rowCount: 0 },
    { rowCount: 1, rows: [{ decision: 'approved' }] },
  ]);
  const result = await recordProposalDecision(
    { proposalId: 'p-12', decision: 'rejected', decidedBy: 'u-3' },
    pool,
  );
  assert.equal(result.updated, false);
  assert.equal(result.existing_decision, 'approved');
});

test('countPendingProposals: returns the count from the query', async () => {
  const { pool, calls } = makeMultiPool([{ rowCount: 1, rows: [{ count: '7' }] }]);
  const n = await countPendingProposals(pool);
  assert.equal(n, 7);
  assert.match(calls[0]!.text, /goal_proposals/);
  assert.match(calls[0]!.text, /decision IS NULL/);
});

test('countPendingProposals: returns 0 when no rows pending', async () => {
  const { pool } = makeMultiPool([{ rowCount: 1, rows: [{ count: '0' }] }]);
  assert.equal(await countPendingProposals(pool), 0);
});

test('countPendingProposals: returns 0 on pool error (fail-open for standup)', async () => {
  const { pool } = makePool({ throws: true });
  assert.equal(await countPendingProposals(pool), 0);
});

test('countPendingProposals: returns 0 when row count shape is unexpected', async () => {
  const { pool } = makeMultiPool([{ rowCount: 0, rows: [] }]);
  assert.equal(await countPendingProposals(pool), 0);
});

test('countPendingProposals: returns 0 when pool resolution throws inside try (KG env unset)', async () => {
  // Simulate the default-pool path on a cold dev box: passing a pool whose
  // query method throws KgPostgresUnavailableError matches the same failure
  // mode as `getKgPool()` throwing on unset env. The catch must convert
  // it to 0 instead of bubbling.
  const throwingPool = {
    query: async () => {
      const { KgPostgresUnavailableError } = await import('../../agents/indexer/pg-client.js');
      throw new KgPostgresUnavailableError('IFLEET_KG_DATABASE_URL is not set');
    },
  } as unknown as Pool;
  assert.equal(await countPendingProposals(throwingPool), 0);
});
