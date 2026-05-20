// Regression cover for PR #161 (and its audit follow-ups, #162-adjacent).
//
// Two failure modes this file guards against:
//   1. A future pipeline stage forgets to thread `worktreePath` into its
//      `workerPool.spawn` call. The original bug let the architect run in
//      the daemon's cwd (the host IFleet repo) and rogue-commit there. Each
//      stage now has a spawn-opts spy test below.
//   2. Someone removes the fail-loud guard in `buildWorkerPool.spawn` and
//      restores the silent `resolve('.')` fallback. The first test covers
//      this seam directly so the bug can't regress through that route.

import { describe, it, expect } from 'vitest';
import { runArchitect } from '../architect.js';
import { runPlanReviewer } from '../plan-reviewer.js';
import { runReviewer } from '../diff-reviewer.js';
import { runDoctor } from '../doctor.js';
import { buildWorkerPool } from '../factory.js';
import type { WorkerSpec } from '../types.js';
import {
  approveJson,
  makeMockIssueCommenter,
  makeMockWorkerPool,
  makeTask,
  PLAN_OUTPUT,
} from './helpers.js';

const WORKTREE = '/tmp/test-worktree-sandboxing';

const architectSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  workerId: 'architect-1',
};
const planReviewerSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-haiku-4-5-20251001',
  workerId: 'plan-reviewer-1',
};
const editorSpec: WorkerSpec = {
  provider: 'codex',
  model: 'gpt-5.5-codex',
  workerId: 'codex-1',
};
const reviewerSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  workerId: 'reviewer-1',
};
const haikuGateSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-haiku-4-5-20251001',
  workerId: 'haiku-gate-1',
};
const doctorSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  workerId: 'doctor-1',
};

describe('worktree sandboxing — buildWorkerPool fail-loud guard (C2)', () => {
  it('throws when role spawn is called without worktreePath', () => {
    const pool = buildWorkerPool({
      id: 'w-1',
      provider: 'claude',
      authProfile: 'default',
      models: ['sonnet-4.6'],
      maxConcurrent: 1,
      enabled: true,
    });

    expect(() =>
      pool.spawn(architectSpec, 'brief', {
        role: 'architect',
        abortSignal: new AbortController().signal,
        // worktreePath intentionally absent
      }),
    ).toThrow(/worktreePath/);
  });

  it('error message names the offending role and warns about host repo', () => {
    const pool = buildWorkerPool({
      id: 'w-1',
      provider: 'claude',
      authProfile: 'default',
      models: ['sonnet-4.6'],
      maxConcurrent: 1,
      enabled: true,
    });

    expect(() =>
      pool.spawn(doctorSpec, 'brief', {
        role: 'doctor',
        abortSignal: new AbortController().signal,
      }),
    ).toThrow(/role="doctor".*host repo|host repo.*role="doctor"/s);
  });
});

describe('worktree sandboxing — spawn-opts threading per stage (I2)', () => {
  it('architect spawn passes worktreePath', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const issues = makeMockIssueCommenter(true);

    await runArchitect({
      task: makeTask({ autonomy: 'auto' }),
      workerPool,
      spec: architectSpec,
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      worktreePath: WORKTREE,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });

  it('architect interview spawn passes worktreePath', async () => {
    // Vague brief routes through the interview spawn first. We supply a
    // poster so the interview branch runs and inspect that spawn's opts.
    const workerPool = makeMockWorkerPool([
      { role: 'architect', output: '<questions>\n1. What is the scope?\n</questions>' },
    ]);
    const issues = makeMockIssueCommenter(true);
    const poster = {
      async post() {
        return { threadId: 'thread-1', messageId: 'msg-1' };
      },
    };

    await runArchitect({
      task: makeTask({ autonomy: 'auto', body: 'vague' }),
      workerPool,
      spec: architectSpec,
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      worktreePath: WORKTREE,
      interviewPoster: poster,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });

  it('plan-reviewer spawn passes worktreePath', async () => {
    const workerPool = makeMockWorkerPool([
      { role: 'reviewer', output: JSON.stringify({ decision: 'approve', rationale: 'ok' }) },
    ]);

    await runPlanReviewer({
      plan: PLAN_OUTPUT,
      brief: 'add hello()',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool,
      abortSignal: new AbortController().signal,
      worktreePath: WORKTREE,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });

  it('diff-reviewer full spawn passes worktreePath', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'reviewer', output: approveJson() }]);

    await runReviewer({
      editorSpec,
      reviewerSpec,
      workerPool,
      brief: 'add hello()',
      plan: PLAN_OUTPUT,
      diff: 'diff --git a/x b/x\n+hello',
      abortSignal: new AbortController().signal,
      worktreePath: WORKTREE,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });

  it('haiku gate spawn passes worktreePath (before falling through to full reviewer)', async () => {
    // Gate returns CLEAN, so only one spawn happens — and it's the gate.
    const workerPool = makeMockWorkerPool([{ role: 'reviewer', output: 'CLEAN' }]);

    await runReviewer({
      editorSpec,
      reviewerSpec,
      haikuGateSpec,
      workerPool,
      brief: 'add hello()',
      plan: PLAN_OUTPUT,
      diff: 'diff --git a/x b/x\n+hello',
      abortSignal: new AbortController().signal,
      worktreePath: WORKTREE,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });

  it('doctor spawn passes worktreePath', async () => {
    const workerPool = makeMockWorkerPool([
      {
        role: 'doctor',
        output: JSON.stringify({
          rootCause: 'x',
          proposedFix: 'y',
          confidence: 0.9,
          requiresNewBrief: false,
        }),
      },
    ]);

    await runDoctor({
      spec: doctorSpec,
      workerPool,
      brief: 'add hello()',
      plan: PLAN_OUTPUT,
      diff: 'diff --git a/x b/x\n+hello',
      ciLog: 'fail',
      abortSignal: new AbortController().signal,
      worktreePath: WORKTREE,
    });

    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.worktreePath).toBe(WORKTREE);
  });
});
