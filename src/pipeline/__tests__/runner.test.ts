import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPipelineRunner } from '../runner.js';
import { readCostLog } from '../../utils/costs.js';
import {
  approveJson,
  buildPipelineInput,
  doctorJson,
  PLAN_OUTPUT,
  rejectJson,
} from './helpers.js';

describe('DefaultPipelineRunner', () => {
  it('happy path: architect → editor → verify → reviewer → PR opened', async () => {
    const { input, pr, issues } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote code' },
        { role: 'reviewer', output: approveJson() },
      ],
      verify: [{ ok: true, failures: [] }],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(result.prUrl).toContain('/pull/123');
    expect(pr.opened).toHaveLength(1);
    expect(pr.opened[0]?.body).toContain('Closes #42');
    expect(issues.comments).toHaveLength(1);
    expect(issues.comments[0]?.body).toContain('Architect plan');
    expect(result.attempts.map((a) => a.role)).toEqual(['architect', 'editor', 'reviewer']);
  });

  it('reviewer rejects → editor retries → reviewer approves → PR opens', async () => {
    const { input, pr } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'first pass' },
        { role: 'reviewer', output: rejectJson(['src/hello.ts:3 missing return type']) },
        { role: 'editor', output: 'fix pass' },
        { role: 'reviewer', output: approveJson() },
      ],
      verify: [
        { ok: true, failures: [] }, // initial verify
        { ok: true, failures: [] }, // verify after fix pass
      ],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    expect(result.attempts.filter((a) => a.role === 'editor')).toHaveLength(2);
    expect(result.attempts.filter((a) => a.role === 'reviewer')).toHaveLength(2);
  });

  it('reviewer keeps rejecting → blocked_by_reviewer after 2 rounds', async () => {
    const { input, pr } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'first' },
        { role: 'reviewer', output: rejectJson(['bad']) },
        { role: 'editor', output: 'second' },
        { role: 'reviewer', output: rejectJson(['still bad']) },
      ],
      verify: [
        { ok: true, failures: [] },
        { ok: true, failures: [] },
      ],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('blocked_by_reviewer');
    expect(pr.opened).toHaveLength(0);
    expect(result.reviewSummary).toContain('still bad');
  });

  it('doctor retry limit: verify fails → doctor → editor → verify fails → doctor → editor → verify fails → failed', async () => {
    const { input, pr } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'first' },
        { role: 'doctor', output: doctorJson() },
        { role: 'editor', output: 'second' },
        { role: 'doctor', output: doctorJson() },
        { role: 'editor', output: 'third' },
      ],
      verify: [
        { ok: false, failures: [{ kind: 'typecheck', log: 'TS error' }] },
        { ok: false, failures: [{ kind: 'typecheck', log: 'TS error 2' }] },
        { ok: false, failures: [{ kind: 'typecheck', log: 'TS error 3' }] },
      ],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('doctor retry limit');
    expect(pr.opened).toHaveLength(0);
    expect(result.attempts.filter((a) => a.role === 'doctor')).toHaveLength(2);
  });

  it('cross-provider rule: reviewer same provider as editor → failed before any spawn', async () => {
    const { input, workerPool } = buildPipelineInput({
      scripted: [],
      routing: {
        editor: { provider: 'codex', model: 'gpt-5.5-codex', workerId: 'codex-1' },
        reviewer: { provider: 'codex', model: 'gpt-5.5-codex', workerId: 'codex-2' },
      },
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/opposite/);
    expect(workerPool.calls).toHaveLength(0);
  });

  it('cross-provider rule: claude editor + claude reviewer in multi-provider pool → failed before any spawn', async () => {
    // architect=codex makes the pool multi-provider → strict rule applies
    const { input, workerPool } = buildPipelineInput({
      scripted: [],
      routing: {
        architect: { provider: 'codex', model: 'gpt-5.5', workerId: 'codex-0' },
        editor: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-1' },
        reviewer: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-2' },
      },
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/opposite/);
    expect(workerPool.calls).toHaveLength(0);
  });

  it('cross-provider rule: single-provider pool warns but does not block pipeline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // all roles claude → pool size 1 → permissive mode
    const { input } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'done' },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: {
        architect: { provider: 'claude', model: 'haiku-4.5', workerId: 'claude-0' },
        editor: { provider: 'claude', model: 'haiku-4.5', workerId: 'claude-1' },
        reviewer: { provider: 'claude', model: 'haiku-4.5', workerId: 'claude-2' },
      },
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cross-provider rule skipped'));
    expect(result.failureReason ?? '').not.toMatch(/opposite/);
    warn.mockRestore();
  });

  it('PR gating: verify fails after reviewer fix-pass → failed, no PR opened', async () => {
    const { input, pr } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'first pass' },
        { role: 'reviewer', output: rejectJson(['src/x.ts:1 nit']) },
        { role: 'editor', output: 'fix pass' },
        // Reviewer round 2 should NOT be reached; verify-after-fix bails.
      ],
      verify: [
        { ok: true, failures: [] }, // initial verify passes
        { ok: false, failures: [{ kind: 'typecheck', log: 'TS regression' }] }, // post-fix verify fails
      ],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('verify failed after reviewer fix-pass');
    expect(pr.opened).toHaveLength(0);
  });

  it('empty diff guard: editor returns ok but no file changes → failed before reviewer spawns', async () => {
    // Mirrors the silent-tool-use-failure mode we see when `claude -p` print
    // mode runs on haiku: the worker exits with ok=true but the git worktree
    // has no staged changes. Without the guard the reviewer is spawned with
    // an empty diff and burns tokens returning "no diff provided".
    const { input, workerPool, pr } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote nothing' },
        // Reviewer should NOT be reached — no scripted reviewer here.
      ],
    });
    // Force git.diff to return empty whitespace.
    input.git = {
      async diff() {
        return '   \n  \n';
      },
      async currentBranch() {
        return 'feat/x';
      },
    };

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('editor produced no diff');
    expect(pr.opened).toHaveLength(0);
    // architect + editor spawned, reviewer did not
    expect(workerPool.calls).toHaveLength(2);
    expect(workerPool.calls.map((c) => c.opts.role)).toEqual(['architect', 'editor']);
  });

  it('empty plan guard: architect returns whitespace → failed before editor spawns', async () => {
    const { input, workerPool, pr } = buildPipelineInput({
      scripted: [{ role: 'architect', output: '   \n  \n' }],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('empty plan');
    expect(pr.opened).toHaveLength(0);
    // architect spawned, editor did not
    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.role).toBe('architect');
  });

  it('autonomy:review waits for approval and aborts when denied', async () => {
    const { input, issues } = buildPipelineInput({
      task: { autonomy: 'review' },
      scripted: [{ role: 'architect', output: PLAN_OUTPUT }],
      approvalResult: false,
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('not approved');
    expect(issues.approvals).toHaveLength(1);
    expect(issues.approvals[0]?.approver).toBe('@monstersebas1');
  });

  it('autonomy:review proceeds when approval is granted', async () => {
    const { input, issues } = buildPipelineInput({
      task: { autonomy: 'review' },
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'code' },
        { role: 'reviewer', output: approveJson() },
      ],
      approvalResult: true,
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(issues.approvals).toHaveLength(1);
  });

  it('haiku gate CLEAN: full reviewer skipped, PR still opens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote code' },
        // Only the gate spawn runs for the reviewer round — no full reviewer
        // entry because CLEAN short-circuits.
        { role: 'reviewer', output: 'CLEAN' },
      ],
      routing: {
        haikuGate: { provider: 'claude', model: 'claude-haiku-4-5-20251001', workerId: 'gate-1' },
      },
      verify: [{ ok: true, failures: [] }],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    // 3 spawns total: architect, editor, gate. Full reviewer never spawned.
    expect(workerPool.calls).toHaveLength(3);
    const reviewerCalls = workerPool.calls.filter((c) => c.opts.role === 'reviewer');
    expect(reviewerCalls).toHaveLength(1);
    expect(reviewerCalls[0]?.spec.workerId).toBe('gate-1');
    // The reviewer attempt is recorded with gate='haiku'.
    const reviewerAttempt = result.attempts.find((a) => a.role === 'reviewer');
    expect(reviewerAttempt?.gate).toBe('haiku');
    expect(reviewerAttempt?.workerId).toBe('gate-1');
    expect(
      logSpy.mock.calls.some(([msg]) =>
        typeof msg === 'string' && msg.startsWith('reviewer:haiku-gate-passed'),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('haiku gate REVIEW_NEEDED: full reviewer runs and decides the round', async () => {
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote code' },
        // Gate escalates → full reviewer spawns next and approves.
        { role: 'reviewer', output: 'REVIEW_NEEDED: touches auth' },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: {
        haikuGate: { provider: 'claude', model: 'claude-haiku-4-5-20251001', workerId: 'gate-1' },
      },
      verify: [{ ok: true, failures: [] }],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    // 4 spawns: architect, editor, gate, full reviewer.
    expect(workerPool.calls).toHaveLength(4);
    const reviewerCalls = workerPool.calls.filter((c) => c.opts.role === 'reviewer');
    expect(reviewerCalls).toHaveLength(2);
    // The recorded reviewer attempt is the FULL reviewer (gate output is
    // intentionally not logged as a separate attempt — see reviewer.ts).
    const reviewerAttempt = result.attempts.find((a) => a.role === 'reviewer');
    expect(reviewerAttempt?.gate).toBe('full');
    expect(reviewerAttempt?.workerId).not.toBe('gate-1');
  });

  it('haiku gate errors → full reviewer runs (safe fallback)', async () => {
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote code' },
        // Gate worker fails (ok=false) → fall through to full reviewer.
        { role: 'reviewer', output: '', ok: false },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: {
        haikuGate: { provider: 'claude', model: 'claude-haiku-4-5-20251001', workerId: 'gate-1' },
      },
      verify: [{ ok: true, failures: [] }],
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    expect(workerPool.calls).toHaveLength(4);
    const reviewerAttempt = result.attempts.find((a) => a.role === 'reviewer');
    expect(reviewerAttempt?.gate).toBe('full');
  });

  it('cancel mid-pipeline (abort before architect runs) → cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, workerPool } = buildPipelineInput({
      scripted: [],
      abortSignal: controller.signal,
    });

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('cancelled');
    expect(workerPool.calls).toHaveLength(0);
  });

  it('cost propagation: adapter-reported totalCostUsd reaches AttemptRecord and costs.json', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ifleet-cost-test-'));
    try {
      const { input } = buildPipelineInput({
        scripted: [
          { role: 'architect', output: PLAN_OUTPUT, totalCostUsd: 0.42 },
          { role: 'editor', output: 'wrote code', totalCostUsd: 1.23 },
          { role: 'reviewer', output: approveJson(), totalCostUsd: 0.08 },
        ],
        verify: [{ ok: true, failures: [] }],
        repoRoot,
      });

      const result = await new DefaultPipelineRunner().run(input);

      expect(result.status).toBe('pr_opened');
      const byRole = Object.fromEntries(result.attempts.map((a) => [a.role, a]));
      expect(byRole.architect?.totalCostUsd).toBe(0.42);
      expect(byRole.editor?.totalCostUsd).toBe(1.23);
      expect(byRole.reviewer?.totalCostUsd).toBe(0.08);

      const records = await readCostLog(repoRoot);
      const costsByRole = Object.fromEntries(records.map((r) => [r.role, r.totalCostUsd]));
      expect(costsByRole.architect).toBe(0.42);
      expect(costsByRole.editor).toBe(1.23);
      expect(costsByRole.reviewer).toBe(0.08);
      const grandTotal = records.reduce((sum, r) => sum + r.totalCostUsd, 0);
      expect(grandTotal).toBeCloseTo(1.73, 5);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('cost propagation: adapter omits totalCostUsd → AttemptRecord undefined, log records 0', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ifleet-cost-test-'));
    try {
      const { input } = buildPipelineInput({
        scripted: [
          { role: 'architect', output: PLAN_OUTPUT },
          { role: 'editor', output: 'wrote code' },
          { role: 'reviewer', output: approveJson() },
        ],
        verify: [{ ok: true, failures: [] }],
        repoRoot,
      });

      const result = await new DefaultPipelineRunner().run(input);

      expect(result.status).toBe('pr_opened');
      for (const attempt of result.attempts) {
        expect(attempt.totalCostUsd).toBeUndefined();
      }
      const records = await readCostLog(repoRoot);
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.totalCostUsd).toBe(0);
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('deep interview: vague brief + interviewPoster → awaiting_interview, no editor spawn', async () => {
    const posts: Array<{ taskId: string; questions: string[] }> = [];
    const { input, workerPool, pr } = buildPipelineInput({
      // Vague body so interview triggers; only the interview spawn runs.
      task: { body: 'improve the dashboard? maybe? somehow?' },
      scripted: [
        {
          role: 'architect',
          output: `<questions>
1. Which dashboard?
2. What metric matters?
3. Is mobile in scope?
</questions>`,
        },
      ],
    });
    input.interviewPoster = {
      async post({ taskId, questions }) {
        posts.push({ taskId, questions });
        return { channelId: 'C1', threadId: 'T1', messageId: 'M1' };
      },
    };

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('awaiting_interview');
    expect(result.interviewQuestions).toHaveLength(3);
    expect(result.interviewQuestions?.[0]).toBe('Which dashboard?');
    expect(pr.opened).toHaveLength(0);
    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.role).toBe('architect');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.taskId).toBe(input.task.id);
  });

  it('cancel after architect approved but before editor → cancelled', async () => {
    const controller = new AbortController();
    const { input, pr } = buildPipelineInput({
      task: { autonomy: 'review' },
      scripted: [{ role: 'architect', output: PLAN_OUTPUT }],
      approvalResult: true,
      abortSignal: controller.signal,
    });

    // Abort right after the architect approval would resolve. Issues mock resolves
    // synchronously, so we patch the issues to abort during waitForApproval.
    input.issues.waitForApproval = async () => {
      controller.abort();
      return true;
    };

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('cancelled');
    expect(pr.opened).toHaveLength(0);
  });
});
