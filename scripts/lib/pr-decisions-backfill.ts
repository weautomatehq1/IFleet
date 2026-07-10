/**
 * Pure mapping module for `scripts/backfill-pr-decisions.ts`.
 *
 * Splits the I/O-free logic (gh JSON → RecordPrDecisionInput) from the CLI
 * wrapper so it can be unit-tested without shelling out or touching SQLite.
 *
 * Schema target: src/queue/store.ts → RecordPrDecisionInput. `task_id` is
 * NOT NULL there, so historical PRs that did not originate from an IFleet
 * task get the sentinel `backfill:<pr_url>` task id.
 */

import type { PrVerdict, RecordPrDecisionInput } from '@wahq/orchestrator-core/queue/store';

export interface GhReview {
  state?: string;
  // Review authors from `gh pr list --json reviews` do NOT include `is_bot`.
  // Detect bots via login suffix (`[bot]`) — see `isBotLogin`.
  author?: { login?: string } | null;
  submittedAt?: string;
}

export interface GhPullRequest {
  url: string;
  number: number;
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
  author?: { login?: string; is_bot?: boolean } | null;
  reviews?: GhReview[];
}

export function isBotLogin(login: string | undefined | null): boolean {
  return !!login && login.endsWith('[bot]');
}

export interface MappedPr {
  input: RecordPrDecisionInput;
  pr: GhPullRequest;
}

export interface MapOutcome {
  mapped: MappedPr[];
  skipped: Array<{ pr: GhPullRequest; reason: string }>;
}

export function classifyVerdict(pr: GhPullRequest): PrVerdict | null {
  if (pr.state === 'MERGED' || pr.mergedAt) return 'merged';
  if (pr.state === 'OPEN') return null;
  const hasHumanChangesRequested = (pr.reviews ?? []).some(
    (r) =>
      (r.state ?? '').toUpperCase() === 'CHANGES_REQUESTED' &&
      !isBotLogin(r.author?.login),
  );
  if (hasHumanChangesRequested) return 'rejected';
  return 'abandoned';
}

export function pickReviewerLogin(pr: GhPullRequest): string | undefined {
  const reviews = pr.reviews ?? [];
  // Prefer the latest review with a concrete verdict from a non-bot reviewer.
  const ranked = [...reviews]
    .filter((r) => {
      const state = (r.state ?? '').toUpperCase();
      return state === 'APPROVED' || state === 'CHANGES_REQUESTED';
    })
    .filter((r) => r.author?.login && !isBotLogin(r.author.login))
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return ranked[0]?.author?.login ?? undefined;
}

export function parseTimestamp(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export function mapPullRequest(
  pr: GhPullRequest,
  repo: string,
): MappedPr | { skipped: string } {
  const verdict = classifyVerdict(pr);
  if (!verdict) return { skipped: `pr#${pr.number} is open` };

  const input: RecordPrDecisionInput = {
    taskId: `backfill:${pr.url}`,
    repo,
    prNumber: pr.number,
    verdict,
    reviewerLogin: pickReviewerLogin(pr),
    mergedAt: parseTimestamp(pr.mergedAt),
  };
  return { input, pr };
}

export function mapPullRequests(prs: GhPullRequest[], repo: string): MapOutcome {
  const mapped: MappedPr[] = [];
  const skipped: Array<{ pr: GhPullRequest; reason: string }> = [];
  for (const pr of prs) {
    const result = mapPullRequest(pr, repo);
    if ('skipped' in result) skipped.push({ pr, reason: result.skipped });
    else mapped.push(result);
  }
  return { mapped, skipped };
}
