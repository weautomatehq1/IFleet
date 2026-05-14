import { describe, it, expect, vi } from 'vitest';
import { DefaultPipelineRunner } from '../runner.js';
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
