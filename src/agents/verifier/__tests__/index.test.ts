/**
 * VerifierAgent — M0.W1 scaffold smoke tests.
 *
 * These exercise the event contract end-to-end with the stub sandbox. They are
 * the canary that M1.W2 must preserve when swapping the stub for real Docker.
 */
import { describe, expect, it } from 'vitest';
import { VerifierAgent, MAX_VERIFIER_ATTEMPTS } from '../index.js';
import { StubSandboxRunner } from '../sandbox.js';
import type { OrchestratorEvent, SprintId, TaskId } from '../../../orchestrator/types.js';

const sprintId = 's-test' as SprintId;
const taskId = 't-test' as TaskId;
const baseInput = {
  sprintId,
  taskId,
  repoUrl: 'https://github.com/weautomatehq1/IFleet',
  branch: 'feat/scaffold',
  sha: 'deadbeef',
};

describe('VerifierAgent (scaffold)', () => {
  it('emits verifier.started then verifier.passed in order', async () => {
    const events: OrchestratorEvent[] = [];
    const agent = new VerifierAgent({
      emit: (e) => events.push(e),
      sandbox: new StubSandboxRunner(),
    });

    const result = await agent.verify(baseInput);

    expect(result.status).toBe('passed');
    expect(result.failures).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(['verifier.started', 'verifier.passed']);
    const [startedEvent, finalEvent] = events;
    expect(startedEvent?.sprintId).toBe(sprintId);
    expect(startedEvent?.taskId).toBe(taskId);
    expect(finalEvent?.payload.runId).toBe(result.runId);
  });

  it('defaults attempt to 1 and propagates it through events', async () => {
    const events: OrchestratorEvent[] = [];
    const agent = new VerifierAgent({ emit: (e) => events.push(e) });
    const result = await agent.verify(baseInput);
    expect(result.attempt).toBe(1);
    expect(events[0]?.payload.attempt).toBe(1);
  });

  it('honors caller-supplied attempt number', async () => {
    const events: OrchestratorEvent[] = [];
    const agent = new VerifierAgent({ emit: (e) => events.push(e) });
    const result = await agent.verify({ ...baseInput, attempt: 2 });
    expect(result.attempt).toBe(2);
    expect(events[0]?.payload.attempt).toBe(2);
  });

  it('emits verifier.error when sandbox throws and rethrows the error', async () => {
    const events: OrchestratorEvent[] = [];
    const failingSandbox = {
      run: () => Promise.reject(new Error('docker daemon unreachable')),
    };
    const agent = new VerifierAgent({
      emit: (e) => events.push(e),
      sandbox: failingSandbox,
    });

    await expect(agent.verify(baseInput)).rejects.toThrow('docker daemon unreachable');
    expect(events.map((e) => e.kind)).toEqual(['verifier.error']);
    expect(events[0]?.payload.error).toBe('docker daemon unreachable');
  });

  it('MAX_VERIFIER_ATTEMPTS is the documented 3-retry cap', () => {
    expect(MAX_VERIFIER_ATTEMPTS).toBe(3);
  });
});
