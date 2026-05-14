import type { Octokit } from '@octokit/rest';
import type { IssueCommenter, WaitForApprovalOpts } from '../pipeline/types.js';

const APPROVAL_REACTIONS = new Set(['+1', 'eyes']);

export function createIssueCommenter(
  octokit: Octokit,
  owner: string,
  repo: string,
): IssueCommenter {
  let lastCommentId: number | null = null;

  return {
    async comment(issueNumber: number, body: string): Promise<void> {
      const res = await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      lastCommentId = res.data.id;
    },

    async waitForApproval(
      _issueNumber: number,
      opts: WaitForApprovalOpts,
    ): Promise<boolean> {
      if (lastCommentId === null) {
        throw new Error(
          'waitForApproval called before comment() — no plan comment to poll for reactions',
        );
      }
      const commentId = lastCommentId;
      const approverLogin = opts.approver.replace(/^@/, '');
      const deadline = Date.now() + opts.timeoutMs;

      while (Date.now() < deadline) {
        if (opts.abortSignal.aborted) return false;

        const reactions = await octokit.reactions.listForIssueComment({
          owner,
          repo,
          comment_id: commentId,
        });

        const approved = reactions.data.some(
          (r) =>
            APPROVAL_REACTIONS.has(r.content) && r.user?.login === approverLogin,
        );
        if (approved) return true;

        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const sleepFor = Math.min(opts.pollIntervalMs, remaining);
        const slept = await sleepOrAbort(sleepFor, opts.abortSignal);
        if (!slept) return false;
      }
      return false;
    },
  };
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
