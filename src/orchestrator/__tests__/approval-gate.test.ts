import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ControlPlaneApprovalGate } from '../approval-gate.js';

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
