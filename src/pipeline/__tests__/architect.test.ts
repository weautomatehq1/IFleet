import { describe, it, expect } from 'vitest';
import { runArchitect } from '../architect.js';
import type { IssueCommenter, WaitForApprovalOpts } from '../types.js';
import { makeMockWorkerPool, makeTask, PLAN_OUTPUT } from './helpers.js';

interface ApprovalCall {
  issueNumber: number;
  opts: WaitForApprovalOpts;
}

function makeIssues(approvalResult: boolean): {
  issues: IssueCommenter;
  comments: Array<{ issueNumber: number; body: string }>;
  approvals: ApprovalCall[];
} {
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const approvals: ApprovalCall[] = [];
  const issues: IssueCommenter = {
    async comment(issueNumber, body) {
      comments.push({ issueNumber, body });
    },
    async waitForApproval(issueNumber, opts) {
      approvals.push({ issueNumber, opts });
      return approvalResult;
    },
  };
  return { issues, comments, approvals };
}

describe('runArchitect — HITL via reactions', () => {
  it('plan comment ends with a reaction instruction (✅), proving reaction-based HITL', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues, comments } = makeIssues(true);

    await runArchitect({
      task: makeTask({ autonomy: 'review' }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
    });

    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? '';
    expect(body).toContain('Architect plan');
    // The reaction instruction is the contract — if this string changes, the
    // reaction-based HITL gate in src/queue/issue-commenter.ts breaks silently.
    expect(body).toMatch(/React with ✅/);
    // Should NOT instruct users to leave a text comment for approval.
    expect(body).not.toMatch(/reply with|comment with|type approve/i);
  });

  it('autonomy:review calls waitForApproval with the approver and abortSignal', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues, approvals } = makeIssues(true);
    const controller = new AbortController();

    const result = await runArchitect({
      task: makeTask({ autonomy: 'review', issueNumber: 99 }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: controller.signal,
      approver: '@monstersebas1',
      approvalPollMs: 1000,
      approvalTimeoutMs: 5000,
    });

    expect(result.approved).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.issueNumber).toBe(99);
    expect(approvals[0]?.opts.approver).toBe('@monstersebas1');
    expect(approvals[0]?.opts.abortSignal).toBe(controller.signal);
    expect(approvals[0]?.opts.pollIntervalMs).toBe(1000);
    expect(approvals[0]?.opts.timeoutMs).toBe(5000);
  });

  it('autonomy:auto skips waitForApproval entirely', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues, approvals, comments } = makeIssues(false);

    const result = await runArchitect({
      task: makeTask({ autonomy: 'auto' }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
    });

    expect(result.approved).toBe(true);
    expect(approvals).toHaveLength(0);
    // Comment still posted so reviewers can see the plan after the fact.
    expect(comments).toHaveLength(1);
  });

  it('autonomy:review returns approved=false when reaction never lands', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues } = makeIssues(false);

    const result = await runArchitect({
      task: makeTask({ autonomy: 'review' }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
    });

    expect(result.approved).toBe(false);
  });
});
