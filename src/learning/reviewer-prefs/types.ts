/**
 * Reviewer preference card types (M4-T3).
 *
 * A card summarises a single reviewer's structural accept/reject history over
 * a rolling window. Cards are written as JSON files to `.ifleet/prefs/` and
 * consumed by the architect's `get_reviewer_prefs` tool (M4-T4), and by the
 * M5 proposer when scoring candidates against the reviewer's track record.
 *
 * The shape is intentionally narrow: only fields the architect / proposer
 * reads. New fields are additive — bump a `schema_version` here if a
 * breaking change is needed.
 */

export interface ReviewerCardStats {
  total_reviews: number;
  merged: number;
  rejected: number;
  deferred: number;
}

export interface ReviewerAcceptPattern {
  /** Short prefix of the structural fingerprint hash. */
  fingerprint_prefix: string;
  /** Number of merged PRs sharing this prefix in the window. */
  count: number;
  /** Sample PR URL — null when no reconstructable URL exists. */
  example_pr: string | null;
}

export interface ReviewerRejectPattern {
  fingerprint_prefix: string;
  count: number;
  example_pr: string | null;
  /** Short hint (sourced from comments later). Null today. */
  reason_hint: string | null;
}

export interface ReviewerCard {
  reviewer: string;
  window_days: number;
  /** ISO-8601 UTC timestamp of card generation. */
  reviewed_at: string;
  stats: ReviewerCardStats;
  accept_patterns: ReviewerAcceptPattern[];
  reject_patterns: ReviewerRejectPattern[];
  notes: string;
}
