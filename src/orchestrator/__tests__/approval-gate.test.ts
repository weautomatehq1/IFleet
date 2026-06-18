import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ControlPlaneApprovalGate,
  recordProposalDecision,
} from '../approval-gate.js';

describe('ControlPlaneApprovalGate', () => {
  it('resolves true when resolve(approve) fires', async () => {
    const gate = new ControlPlaneApprovalGate();
    const controller = new AbortController();
    const p = gate.awaitApproval({
      taskId: 't1',
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    assert.equal(gate.has('t1'), true);
    gate.resolve('t1', 'approve');
    assert.equal(await p, true);
    assert.equal(gate.has('t1'), false);
  });

  it('resolves false when resolve(reject) fires', async () => {
    const gate = new ControlPlaneApprovalGate();
    const controller = new AbortController();
    const p = gate.awaitApproval({
      taskId: 't2',
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    gate.resolve('t2', 'reject');
    assert.equal(await p, false);
  });

  it('resolves false on timeout', async () => {
    const gate = new ControlPlaneApprovalGate();
    const controller = new AbortController();
    const p = gate.awaitApproval({
      taskId: 't3',
      timeoutMs: 10,
      abortSignal: controller.signal,
    });
    assert.equal(await p, false);
  });

  it('resolves false on abort', async () => {
    const gate = new ControlPlaneApprovalGate();
    const controller = new AbortController();
    const p = gate.awaitApproval({
      taskId: 't4',
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    controller.abort();
    assert.equal(await p, false);
  });

  it('returns false immediately if abortSignal is already aborted', async () => {
    const gate = new ControlPlaneApprovalGate();
    const controller = new AbortController();
    controller.abort();
    const result = await gate.awaitApproval({
      taskId: 't5',
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    assert.equal(result, false);
    assert.equal(gate.has('t5'), false);
  });

  it('drain resolves all pending as cancelled', async () => {
    const gate = new ControlPlaneApprovalGate();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = gate.awaitApproval({ taskId: 'd1', timeoutMs: 60_000, abortSignal: c1.signal });
    const p2 = gate.awaitApproval({ taskId: 'd2', timeoutMs: 60_000, abortSignal: c2.signal });
    gate.drain();
    assert.equal(await p1, false);
    assert.equal(await p2, false);
  });
});

describe('recordProposalDecision (kind: proposal)', () => {
  type QueryCall = { sql: string; params: unknown[] };

  function makePool(rowCount: number): { pool: unknown; calls: QueryCall[] } {
    const calls: QueryCall[] = [];
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rowCount, rows: rowCount === 1 ? [{ id: String(params[0]) }] : [] };
      },
    };
    return { pool, calls };
  }

  it('writes approved decision and reports updated:true', async () => {
    const { pool, calls } = makePool(1);
    const result = await recordProposalDecision({
      kind: 'proposal',
      proposalId: 'prop-1',
      decision: 'approved',
      decidedBy: 'user-123',
       
      pool: pool as any,
    });
    assert.equal(result.updated, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /UPDATE goal_proposals/);
    assert.equal(calls[0]!.params[0], 'prop-1');
    assert.equal(calls[0]!.params[1], 'approved');
    assert.equal(calls[0]!.params[2], 'user-123');
    // decidedAt is a fresh ISO timestamp; just assert it parses.
    assert.equal(Number.isFinite(Date.parse(String(calls[0]!.params[3]))), true);
  });

  it('writes rejected decision', async () => {
    const { pool, calls } = makePool(1);
    const result = await recordProposalDecision({
      kind: 'proposal',
      proposalId: 'prop-2',
      decision: 'rejected',
      decidedBy: 'user-456',
       
      pool: pool as any,
    });
    assert.equal(result.updated, true);
    assert.equal(calls[0]!.params[1], 'rejected');
  });

  it('writes deferred decision', async () => {
    const { pool, calls } = makePool(1);
    const result = await recordProposalDecision({
      kind: 'proposal',
      proposalId: 'prop-3',
      decision: 'deferred',
      decidedBy: 'user-789',
       
      pool: pool as any,
    });
    assert.equal(result.updated, true);
    assert.equal(calls[0]!.params[1], 'deferred');
  });

  it('returns updated:false when proposalId does not match any row', async () => {
    const { pool } = makePool(0);
    const result = await recordProposalDecision({
      kind: 'proposal',
      proposalId: 'missing',
      decision: 'approved',
      decidedBy: 'user-x',
       
      pool: pool as any,
    });
    assert.equal(result.updated, false);
  });
});
