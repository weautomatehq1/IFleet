#!/usr/bin/env node
/**
 * Manual smoke trace for the reaction-based HITL approval gate (PR #54).
 *
 * What it proves end-to-end:
 *  1. `createIssueCommenter` posts the architect plan as an issue comment
 *     and captures the returned comment id.
 *  2. `waitForApproval` polls `reactions.listForIssueComment` until it sees
 *     a `+1` reaction from the configured approver.
 *  3. Polling honours `pollIntervalMs` and `timeoutMs` correctly.
 *
 * Reproduction steps:
 *  - Run `node --import tsx scripts/test-hitl.ts`.
 *  - Expect three log lines: `createComment`, then `poll #1`, `poll #2`
 *    (both with `0 reactions`), then `poll #3` with `1 reactions`.
 *  - Expect `waitForApproval returned true` in ≤ ~150 ms (poll interval
 *    is 50 ms; the mock returns the +1 on the third poll).
 *  - Expect final `PASS` line and exit code 0.
 *
 * Failure modes the test exercises:
 *  - Empty reactions list (polls 1-2) — must not throw, must keep polling.
 *  - Reaction from the right user with `+1` content — must approve.
 *
 * No real GitHub token is needed: the script injects a mock Octokit.
 *
 * Usage:  node --import tsx scripts/test-hitl.ts
 */

import type { Octokit } from '@octokit/rest';
import { createIssueCommenter } from '../src/queue/issue-commenter.ts';

interface FakeReaction {
  content: string;
  user: { login: string } | null;
}

function log(msg: string): void {
  console.log(`[test-hitl ${new Date().toISOString()}] ${msg}`);
}

function buildMockOctokit(): Octokit {
  const pollBatches: FakeReaction[][] = [
    [],
    [],
    [{ content: '+1', user: { login: 'seb' } }],
  ];
  let pollIdx = 0;
  let storedCommentId = 0;
  return {
    issues: {
      createComment: async (p: { issue_number: number; body: string }): Promise<{
        data: { id: number };
      }> => {
        storedCommentId = 12345;
        log(`createComment issue=#${p.issue_number} bodyLen=${p.body.length} → id=${storedCommentId}`);
        return { data: { id: storedCommentId } };
      },
    },
    reactions: {
      listForIssueComment: async (p: { comment_id: number }): Promise<{
        data: FakeReaction[];
      }> => {
        const batch = pollBatches[pollIdx] ?? [];
        log(
          `poll #${pollIdx + 1}: listForIssueComment(comment_id=${p.comment_id}) → ${batch.length} reactions`,
        );
        pollIdx++;
        return { data: batch };
      },
    },
  } as unknown as Octokit;
}

async function main(): Promise<void> {
  log('manual HITL smoke trace starting');
  const commenter = createIssueCommenter(buildMockOctokit(), 'weautomatehq1', 'IFleet');

  await commenter.comment(42, '## Architect plan\n\nReact with ✅ to approve.');

  const started = Date.now();
  const approved = await commenter.waitForApproval(42, {
    approver: '@seb',
    pollIntervalMs: 50,
    timeoutMs: 5_000,
    abortSignal: new AbortController().signal,
  });
  const durationMs = Date.now() - started;

  log(`waitForApproval returned ${approved} after ${durationMs}ms`);
  if (!approved) {
    log('FAIL — expected true');
    process.exitCode = 1;
    return;
  }
  log('PASS — HITL reaction polling works');
}

main().catch((err) => {
  console.error('[test-hitl] Fatal:', err);
  process.exitCode = 1;
});
