/**
 * Public API for the reviewer-preferences subsystem (M4-T3).
 *
 * Consumers:
 *   - Architect's `get_reviewer_prefs` tool (M4-T4) → `loadReviewerCard`.
 *   - M5 proposer scorer → `loadReviewerCard` (planned, not yet wired).
 *   - Nightly card regeneration CLI → `buildReviewerCards`.
 */
import { readFileSync } from 'node:fs';
import { defaultPrefsDir, reviewerCardPath } from './build-cards.js';
import type { ReviewerCard } from './types.js';

export {
  buildReviewerCards,
  summariseReviewerDecisions,
  defaultPrefsDir,
  reviewerCardPath,
  writeReviewerCard,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_TOP_N,
  FINGERPRINT_PREFIX_LEN,
} from './build-cards.js';
export type {
  BuildReviewerCardsOptions,
  BuildReviewerCardsResult,
} from './build-cards.js';
export type {
  ReviewerCard,
  ReviewerCardStats,
  ReviewerAcceptPattern,
  ReviewerRejectPattern,
} from './types.js';

export interface LoadReviewerCardOptions {
  /** Override the prefs directory. Defaults to `<cwd>/.ifleet/prefs`. */
  prefsDir?: string;
}

/**
 * Load the most recent card for `reviewer`, or `null` when none exists.
 * Returns `null` (does NOT throw) on ENOENT — the architect's contract.
 * Surfaces JSON parse errors and shape mismatches to the caller because
 * those represent a corrupted file the operator should see.
 */
export function loadReviewerCard(
  reviewer: string,
  opts: LoadReviewerCardOptions = {},
): ReviewerCard | null {
  const dir = opts.prefsDir ?? defaultPrefsDir();
  const path = reviewerCardPath(dir, reviewer);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  assertCard(parsed);
  return parsed;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function assertCard(value: unknown): asserts value is ReviewerCard {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as ReviewerCard).reviewer !== 'string' ||
    typeof (value as ReviewerCard).window_days !== 'number' ||
    typeof (value as ReviewerCard).reviewed_at !== 'string' ||
    typeof (value as ReviewerCard).stats !== 'object'
  ) {
    throw new Error('reviewer card has malformed shape — refusing to return partial data');
  }
}
