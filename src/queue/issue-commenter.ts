import type { Octokit } from '@octokit/rest';
import type { IssueCommenter, WaitForApprovalOpts } from '../pipeline/types.js';

// GitHub reaction `content` values that count as an approval to advance HITL.
// `+1` is the closest equivalent to the spec's "✅" thumbs-up gesture; `rocket`
// and `hooray` are commonly used by reviewers to signal "ship it"; `eyes`
// remains for back-compat with earlier polling behavior.
const APPROVAL_REACTIONS = new Set(['+1', 'rocket', 'hooray', 'eyes']);

export interface IssueCommenterOptions {
  /**
   * Additional approver logins that may advance HITL via a reaction. Combined
   * with the per-call `WaitForApprovalOpts.approver` value at poll time.
   * Typically populated from CODEOWNERS.
   */
  approvers?: string[];
}

function normalizeLogin(login: string): string {
  return login.replace(/^@/, '').toLowerCase();
}

export function createIssueCommenter(
  octokit: Octokit,
  owner: string,
  repo: string,
  options: IssueCommenterOptions = {},
): IssueCommenter {
  let lastCommentId: number | null = null;
  const factoryApprovers = (options.approvers ?? [])
    .map(normalizeLogin)
    .filter((s) => s.length > 0);

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
      const approverSet = new Set<string>(factoryApprovers);
      if (opts.approver) approverSet.add(normalizeLogin(opts.approver));
      if (approverSet.size === 0) {
        throw new Error(
          'waitForApproval: no approvers configured (pass approver via opts or approvers via factory)',
        );
      }
      const deadline = Date.now() + opts.timeoutMs;
      let consecutiveApiErrors = 0;
      const MAX_CONSECUTIVE_API_ERRORS = 5;

      while (Date.now() < deadline) {
        if (opts.abortSignal.aborted) return false;

        try {
          const reactions = await octokit.reactions.listForIssueComment({
            owner,
            repo,
            comment_id: commentId,
          });
          consecutiveApiErrors = 0;

          const approved = reactions.data.some((r) => {
            if (!APPROVAL_REACTIONS.has(r.content)) return false;
            const login = r.user?.login;
            if (!login) return false;
            return approverSet.has(login.toLowerCase());
          });
          if (approved) return true;
        } catch (err) {
          consecutiveApiErrors++;
          console.warn(
            `[issue-commenter] waitForApproval: GitHub API error (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}):`,
            err instanceof Error ? err.message : String(err),
          );
          if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new Error(
              `waitForApproval: GitHub API failed ${MAX_CONSECUTIVE_API_ERRORS} consecutive times — aborting HITL poll`,
            );
          }
        }

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
