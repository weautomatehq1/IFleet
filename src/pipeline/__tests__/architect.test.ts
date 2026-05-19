import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArchitect } from '../architect.js';
import type { IssueCommenter, WaitForApprovalOpts } from '../types.js';
import type { InterviewPoster, InterviewPostRequest, InterviewPostResult } from '../interview.js';
import { LEARNINGS_RELATIVE_PATH, PRIOR_LEARNINGS_HEADER } from '../learnings.js';
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

// === #69 — Per-repo learnings ===

const STRUCTURED_BRIEF = `## Goal

Add a hello() helper to src/hello.ts that returns the string "hello".
This is intentionally long so isVagueBrief returns false: the brief is
explicit, has a clear acceptance section, and contains no question marks.

## Acceptance

- Function is exported
- Unit test covers the return value
- No new dependencies added to package.json
`;

describe('runArchitect — per-repo learnings (#69)', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ifleet-architect-learnings-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('reads .omc/learnings.md and prepends a "## Prior learnings" section to the architect system prompt', async () => {
    await mkdir(join(repoRoot, '.omc'), { recursive: true });
    await writeFile(
      join(repoRoot, LEARNINGS_RELATIVE_PATH),
      '- 2026-05-18 21:15 | task-9 | repo uses pnpm\n- 2026-05-18 21:16 | task-9 | tests in __tests__\n',
      'utf8',
    );
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues } = makeIssues(true);

    await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, body: STRUCTURED_BRIEF }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      repoRoot,
    });

    expect(workerPool.calls).toHaveLength(1);
    const sysPrompt = workerPool.calls[0]?.opts.systemPrompt ?? '';
    expect(sysPrompt).toContain(PRIOR_LEARNINGS_HEADER);
    expect(sysPrompt).toContain('repo uses pnpm');
  });

  it('appends any <learning> blocks the architect emits back into .omc/learnings.md', async () => {
    const planWithLearnings = `${PLAN_OUTPUT}\n\n<learning>repo uses pnpm not npm</learning>\n<learning>tests live in src/**/__tests__</learning>\n`;
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: planWithLearnings }]);
    const { issues } = makeIssues(true);
    const stamp = new Date(Date.UTC(2026, 4, 18, 21, 15));

    await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, id: 'task-69', body: STRUCTURED_BRIEF }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      repoRoot,
      now: () => stamp,
    });

    const content = await readFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), 'utf8');
    expect(content).toBe(
      '- 2026-05-18 21:15 | task-69 | repo uses pnpm not npm\n- 2026-05-18 21:15 | task-69 | tests live in src/**/__tests__\n',
    );
  });

  it('leaves system prompt untouched when no repoRoot is provided (back-compat)', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues } = makeIssues(true);

    await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, body: STRUCTURED_BRIEF }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
    });

    const sysPrompt = workerPool.calls[0]?.opts.systemPrompt ?? '';
    expect(sysPrompt).not.toContain(PRIOR_LEARNINGS_HEADER);
  });
});

// === #71 — Deep interview ===

interface RecordedPost extends InterviewPostRequest {}

function makeInterviewPoster(result: InterviewPostResult = { channelId: 'C1', threadId: 'T1', messageId: 'M1' }): {
  poster: InterviewPoster;
  posts: RecordedPost[];
} {
  const posts: RecordedPost[] = [];
  return {
    posts,
    poster: {
      async post(input) {
        posts.push(input);
        return result;
      },
    },
  };
}

describe('runArchitect — deep interview (#71)', () => {
  it('vague brief: spawns the interview prompt, posts the questions, halts with interview metadata', async () => {
    const workerPool = makeMockWorkerPool([
      {
        role: 'architect',
        output: `<questions>
1. Which page do you mean?
2. Should it persist across sessions?
3. What is the success metric?
</questions>`,
      },
    ]);
    const { issues, comments } = makeIssues(true);
    const { poster, posts } = makeInterviewPoster();

    const result = await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, id: 'task-71', body: 'improve the dashboard? maybe? somehow?' }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      interviewPoster: poster,
    });

    // Worker was called with the interview prompt, not the regular plan prompt.
    expect(workerPool.calls).toHaveLength(1);
    expect(workerPool.calls[0]?.opts.systemPrompt).toContain('<questions>');

    expect(result.approved).toBe(false);
    expect(result.plan).toBe('');
    expect(result.interview?.questions).toEqual([
      'Which page do you mean?',
      'Should it persist across sessions?',
      'What is the success metric?',
    ]);
    expect(result.interview?.post?.threadId).toBe('T1');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.taskId).toBe('task-71');
    // No GitHub plan comment posted — there is no plan yet.
    expect(comments).toHaveLength(0);
  });

  it('long structured brief: skips interview entirely and proceeds to normal planning', async () => {
    const workerPool = makeMockWorkerPool([{ role: 'architect', output: PLAN_OUTPUT }]);
    const { issues } = makeIssues(true);
    const { poster, posts } = makeInterviewPoster();

    const result = await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, body: STRUCTURED_BRIEF }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      interviewPoster: poster,
    });

    expect(posts).toHaveLength(0);
    expect(result.interview).toBeUndefined();
    expect(result.approved).toBe(true);
    expect(result.plan).toBe(PLAN_OUTPUT);
  });

  it('vague brief but architect emits no <questions> block: falls back to normal planning', async () => {
    // Two spawn calls expected: interview spawn (no questions) → planning spawn.
    const workerPool = makeMockWorkerPool([
      { role: 'architect', output: 'I have no questions, proceeding.' },
      { role: 'architect', output: PLAN_OUTPUT },
    ]);
    const { issues } = makeIssues(true);
    const { poster, posts } = makeInterviewPoster();

    const result = await runArchitect({
      task: makeTask({ autonomy: 'auto', issueNumber: 0, body: 'short brief' }),
      workerPool,
      spec: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
      issues,
      abortSignal: new AbortController().signal,
      approver: '@monstersebas1',
      interviewPoster: poster,
    });

    expect(workerPool.calls).toHaveLength(2);
    expect(posts).toHaveLength(0);
    expect(result.interview).toBeUndefined();
    expect(result.approved).toBe(true);
  });
});
