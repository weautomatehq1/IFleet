import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Octokit } from '@octokit/rest';
import { createIssueCommenter } from '../issue-commenter.js';

interface FakeReaction {
  content: string;
  user: { login: string } | null;
}

interface MockOctokitOpts {
  reactionsByPoll?: FakeReaction[][];
  reactionsConstant?: FakeReaction[];
}

interface MockOctokitState {
  createCommentCalls: number;
  listReactionsCalls: Array<{ comment_id: number }>;
}

function makeMockOctokit(opts: MockOctokitOpts): { octokit: Octokit; state: MockOctokitState } {
  const state: MockOctokitState = { createCommentCalls: 0, listReactionsCalls: [] };
  let pollIdx = 0;
  const octokit = {
    issues: {
      createComment: async (_p: unknown): Promise<{ data: { id: number } }> => {
        state.createCommentCalls++;
        return { data: { id: 9001 + state.createCommentCalls } };
      },
    },
    reactions: {
      listForIssueComment: async (p: { comment_id: number }): Promise<{ data: FakeReaction[] }> => {
        state.listReactionsCalls.push({ comment_id: p.comment_id });
        if (opts.reactionsConstant) return { data: opts.reactionsConstant };
        const batch = opts.reactionsByPoll?.[pollIdx] ?? [];
        pollIdx++;
        return { data: batch };
      },
    },
  } as unknown as Octokit;
  return { octokit, state };
}

describe('createIssueCommenter', () => {
  it('comment() posts via octokit and stores the comment id', async () => {
    const { octokit, state } = makeMockOctokit({ reactionsConstant: [] });
    const commenter = createIssueCommenter(octokit, 'weautomatehq1', 'IFleet');
    await commenter.comment(42, 'hello');
    assert.equal(state.createCommentCalls, 1);
  });

  it('waitForApproval returns true when approver leaves a +1 reaction', async () => {
    const { octokit, state } = makeMockOctokit({
      reactionsByPoll: [
        [],
        [],
        [{ content: '+1', user: { login: 'seb' } }],
      ],
    });
    const commenter = createIssueCommenter(octokit, 'weautomatehq1', 'IFleet');
    await commenter.comment(42, 'plan');
    const approved = await commenter.waitForApproval(42, {
      approver: '@seb',
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
    assert.equal(state.listReactionsCalls.length, 3);
    assert.equal(state.listReactionsCalls[0]?.comment_id, 9002);
  });

  it('waitForApproval accepts the eyes reaction as approval', async () => {
    const { octokit } = makeMockOctokit({
      reactionsConstant: [{ content: 'eyes', user: { login: 'seb' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
  });

  it('waitForApproval returns false on timeout', async () => {
    const { octokit } = makeMockOctokit({ reactionsConstant: [] });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    const start = Date.now();
    const approved = await commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 10,
      timeoutMs: 50,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, false);
    assert.ok(Date.now() - start >= 45, 'should have waited until timeout');
  });

  it('waitForApproval returns false when aborted via AbortSignal', async () => {
    const { octokit } = makeMockOctokit({ reactionsConstant: [] });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    const controller = new AbortController();
    const promise = commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 1_000,
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const approved = await promise;
    assert.equal(approved, false);
  });

  it('waitForApproval ignores reactions from other users', async () => {
    const { octokit } = makeMockOctokit({
      reactionsByPoll: [
        [{ content: '+1', user: { login: 'someone-else' } }],
        [{ content: '+1', user: null }],
      ],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 5,
      timeoutMs: 30,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, false);
  });

  it('waitForApproval throws if called before comment()', async () => {
    const { octokit } = makeMockOctokit({ reactionsConstant: [] });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await assert.rejects(
      () =>
        commenter.waitForApproval(1, {
          approver: 'seb',
          pollIntervalMs: 5,
          timeoutMs: 50,
          abortSignal: new AbortController().signal,
        }),
      /comment\(\)/,
    );
  });

  it('waitForApproval accepts a rocket reaction as approval', async () => {
    const { octokit } = makeMockOctokit({
      reactionsConstant: [{ content: 'rocket', user: { login: 'seb' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
  });

  it('factory approvers list lets any CODEOWNER advance with +1', async () => {
    const { octokit } = makeMockOctokit({
      reactionsConstant: [{ content: '+1', user: { login: 'alice' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r', {
      approvers: ['monstersebas1', 'alice', 'bob'],
    });
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: 'monstersebas1',
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
  });

  it('a reaction from a non-CODEOWNER does NOT advance even with factory approvers', async () => {
    const { octokit } = makeMockOctokit({
      reactionsConstant: [{ content: '+1', user: { login: 'random-drive-by' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r', {
      approvers: ['monstersebas1', 'alice'],
    });
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: 'monstersebas1',
      pollIntervalMs: 5,
      timeoutMs: 40,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, false);
  });

  it('approver matching is case-insensitive and strips leading @', async () => {
    const { octokit } = makeMockOctokit({
      reactionsConstant: [{ content: '+1', user: { login: 'MonsterSebas1' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r', {
      approvers: ['@monstersebas1'],
    });
    await commenter.comment(1, 'plan');
    const approved = await commenter.waitForApproval(1, {
      approver: '@somebody-else',
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
  });

  it('throws when no approvers are configured anywhere', async () => {
    const { octokit } = makeMockOctokit({ reactionsConstant: [] });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'plan');
    await assert.rejects(
      () =>
        commenter.waitForApproval(1, {
          approver: '',
          pollIntervalMs: 5,
          timeoutMs: 50,
          abortSignal: new AbortController().signal,
        }),
      /no approvers configured/,
    );
  });

  it('waitForApproval polls the most recently posted comment', async () => {
    const { octokit, state } = makeMockOctokit({
      reactionsConstant: [{ content: '+1', user: { login: 'seb' } }],
    });
    const commenter = createIssueCommenter(octokit, 'o', 'r');
    await commenter.comment(1, 'first');
    await commenter.comment(1, 'second');
    const approved = await commenter.waitForApproval(1, {
      approver: 'seb',
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      abortSignal: new AbortController().signal,
    });
    assert.equal(approved, true);
    assert.equal(state.listReactionsCalls[0]?.comment_id, 9003);
  });
});
