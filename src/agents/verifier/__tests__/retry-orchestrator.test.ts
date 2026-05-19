/**
 * Retry orchestrator unit tests. The handler is pure (side-effects only via
 * injected deps), so each scenario stubs the deps and asserts the decision.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildRetryBrief,
  handleVerifierFailed,
  type RetryOrchestratorDeps,
} from '../retry-orchestrator.js';
import { MAX_VERIFIER_ATTEMPTS } from '../index.js';
import type { OrchestratorEvent, SprintId, TaskId } from '../../../orchestrator/types.js';
import type { VerifierFailure } from '../types.js';

const taskId = 't1' as TaskId;
const sprintId = 's1' as SprintId;

function makeEvent(attempt: number, failures: VerifierFailure[]): OrchestratorEvent {
  return {
    ts: 100,
    sprintId,
    taskId,
    kind: 'verifier.failed',
    payload: { runId: 'r1', status: 'failed', attempt, failures },
  };
}

function makeDeps(overrides: Partial<RetryOrchestratorDeps> = {}): RetryOrchestratorDeps {
  return {
    loadOriginalBrief: overrides.loadOriginalBrief ?? vi.fn().mockResolvedValue('original brief'),
    submitRetrySprint:
      overrides.submitRetrySprint ??
      vi.fn().mockResolvedValue({ sprintId: 's2' as SprintId, taskId: 't2' as TaskId }),
    postFailureSurface: overrides.postFailureSurface ?? vi.fn().mockResolvedValue(undefined),
    ...(overrides.log ? { log: overrides.log } : {}),
  };
}

describe('handleVerifierFailed', () => {
  it('queues a retry sprint when attempt is below the cap', async () => {
    const deps = makeDeps();
    const decision = await handleVerifierFailed(
      makeEvent(1, [{ kind: 'test', message: 'expected ok' }]),
      deps,
    );
    expect(decision.kind).toBe('retry');
    expect(deps.submitRetrySprint).toHaveBeenCalledTimes(1);
    expect(deps.postFailureSurface).toHaveBeenCalledWith(expect.objectContaining({ exhausted: false }));
  });

  it('escalates to human at the cap without queuing another retry', async () => {
    const deps = makeDeps();
    const decision = await handleVerifierFailed(
      makeEvent(MAX_VERIFIER_ATTEMPTS, [{ kind: 'lint', message: 'rule violated' }]),
      deps,
    );
    expect(decision.kind).toBe('exhausted');
    expect(deps.submitRetrySprint).not.toHaveBeenCalled();
    expect(deps.postFailureSurface).toHaveBeenCalledWith(expect.objectContaining({ exhausted: true }));
  });

  it('skips when the original brief cannot be loaded', async () => {
    const deps = makeDeps({ loadOriginalBrief: vi.fn().mockResolvedValue(null) });
    const decision = await handleVerifierFailed(makeEvent(1, []), deps);
    expect(decision.kind).toBe('skipped');
    expect(deps.submitRetrySprint).not.toHaveBeenCalled();
  });

  it('skips events without a taskId (defensive)', async () => {
    const deps = makeDeps();
    const noTaskEvent: OrchestratorEvent = {
      ts: 0,
      sprintId,
      kind: 'verifier.failed',
      payload: { attempt: 1, failures: [] },
    };
    const decision = await handleVerifierFailed(noTaskEvent, deps);
    expect(decision.kind).toBe('skipped');
  });
});

describe('buildRetryBrief', () => {
  it('includes a header, failure list, and the verbatim original brief', () => {
    const brief = buildRetryBrief('the original task description', 2, [
      { kind: 'test', file: 'src/foo.test.ts', line: 12, message: 'expected 1 got 2' },
      { kind: 'typecheck', file: 'src/bar.ts', message: 'no Q on X' },
    ]);
    expect(brief).toContain('Verifier feedback');
    expect(brief).toContain('attempt 2 of 3');
    expect(brief).toContain('src/foo.test.ts:12');
    expect(brief).toContain('the original task description');
  });

  it('truncates failure lists over 20 with overflow note', () => {
    const fails: VerifierFailure[] = Array.from({ length: 25 }, (_, i) => ({
      kind: 'test',
      message: `failure ${i}`,
    }));
    const brief = buildRetryBrief('orig', 2, fails);
    expect(brief).toContain('+ 5 more');
  });
});
