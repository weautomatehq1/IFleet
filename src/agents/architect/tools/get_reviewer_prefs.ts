/**
 * `get_reviewer_prefs(reviewer)` — architect tool (M4-T4).
 *
 * Returns the persisted ReviewerCard for a GitHub handle so the architect
 * can shape its plan against the reviewer's accept/reject history. Returns
 * `null` (does NOT throw) when no card exists for the handle — the
 * architect treats absence as "no priors known."
 *
 * Cards are produced by the nightly `build-reviewer-cards` script and live
 * at `.ifleet/prefs/<handle>.json`. The tool is a thin wrapper around
 * `loadReviewerCard` so the architect's call surface stays decoupled from
 * the file layout.
 */
import { loadReviewerCard } from '../../../learning/reviewer-prefs/index.js';
import type { ReviewerCard } from '../../../learning/reviewer-prefs/index.js';

export interface GetReviewerPrefsDeps {
  /** Override the prefs directory. Defaults to `<cwd>/.ifleet/prefs`. */
  prefsDir?: string;
  /**
   * Override the load function. The architect's test suite plugs an
   * in-memory loader here so we don't need a tmpdir fixture per case.
   */
  loader?: (reviewer: string, prefsDir?: string) => ReviewerCard | null;
}

export async function getReviewerPrefs(
  reviewer: string,
  deps: GetReviewerPrefsDeps = {},
): Promise<ReviewerCard | null> {
  if (typeof reviewer !== 'string' || reviewer.trim() === '') {
    throw new Error('get_reviewer_prefs: reviewer handle must be a non-empty string');
  }
  const loader = deps.loader ?? defaultLoader;
  return loader(reviewer, deps.prefsDir);
}

function defaultLoader(reviewer: string, prefsDir?: string): ReviewerCard | null {
  return loadReviewerCard(reviewer, prefsDir ? { prefsDir } : {});
}

export type { ReviewerCard };
