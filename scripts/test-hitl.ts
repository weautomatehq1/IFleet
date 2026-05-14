#!/usr/bin/env node
/**
 * Manual smoke trace for the HITL approval gate.
 *
 * Runs createIssueCommenter against a mock Octokit that simulates two empty
 * polls followed by a +1 reaction from `seb`. Logs each poll attempt and the
 * final approval. No real GitHub token needed.
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
