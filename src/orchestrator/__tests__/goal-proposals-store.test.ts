import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import {
  extractProposalIdFromIdempotencyKey,
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
