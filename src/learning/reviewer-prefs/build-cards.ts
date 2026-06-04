/**
 * Reviewer card pipeline (M4-T3).
 *
 * Pulls `pr_decisions` rows for a recent window, groups by reviewer, and
 * emits one JSON file per top-N reviewer. Idempotent: re-running with the
 * same DB and same `now` produces identical output bytes (modulo the
 * `reviewed_at` timestamp).
 *
 * Pure mapping logic (`summariseReviewerDecisions`) is split from the I/O
 * layer (`writeReviewerCard`, `buildReviewerCards`) so the projection can be
 * unit-tested against in-memory fixtures without touching disk or SQLite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskStore, type PrDecision } from '../../queue/store.js';
import type { ReviewerCard, ReviewerAcceptPattern, ReviewerRejectPattern } from './types.js';

/** Default window — M4 DoD calls for 30d rolling cards. */
export const DEFAULT_WINDOW_DAYS = 30;
/** Top-N reviewers per task spec. */
export const DEFAULT_TOP_N = 3;
/** Fingerprint prefix length used for the pattern grouping key. */
export const FINGERPRINT_PREFIX_LEN = 12;

export interface BuildReviewerCardsOptions {
  /** Defaults to `<cwd>/state/tasks.db` via `defaultTasksDbPath`. */
  dbPath?: string;
  /** Directory to write `<reviewer>.json` into. Defaults to `<cwd>/.ifleet/prefs`. */
  outDir?: string;
  /** Rolling window in days. Default 30. */
  windowDays?: number;
  /** Number of top reviewers (by total_reviews) to emit. Default 3. */
  topN?: number;
  /** Repo slug to scope by. Omit to include all repos. */
  repo?: string;
  /** Injectable clock — tests pin to a known time. */
  now?: () => number;
  /** Pre-loaded decisions — bypasses the DB read when supplied (tests). */
  decisions?: readonly PrDecision[];
}

export interface BuildReviewerCardsResult {
  cards: ReviewerCard[];
  /** Files actually written. Same order as `cards`. */
  paths: string[];
  /** Distinct reviewers in window before top-N trim. */
  reviewerCount: number;
  /** Total `pr_decisions` rows considered (in window, with reviewer). */
  consideredRows: number;
}

/**
 * Group decisions by reviewer and produce one ReviewerCard per group. Sorted
 * by `total_reviews` descending, then reviewer name ascending (stable for
 * idempotency). Pure: no I/O, no clock dependency beyond the supplied `now`.
 */
export function summariseReviewerDecisions(
  decisions: readonly PrDecision[],
  opts: { windowDays: number; reviewedAt: string },
): ReviewerCard[] {
  const groups = new Map<string, PrDecision[]>();
  for (const d of decisions) {
    if (!d.reviewerLogin) continue;
    const arr = groups.get(d.reviewerLogin) ?? [];
    arr.push(d);
    groups.set(d.reviewerLogin, arr);
  }

  const cards: ReviewerCard[] = [];
  for (const [reviewer, rows] of groups.entries()) {
    cards.push(buildCardForReviewer(reviewer, rows, opts));
  }

  cards.sort((a, b) => {
    if (b.stats.total_reviews !== a.stats.total_reviews) {
      return b.stats.total_reviews - a.stats.total_reviews;
    }
    return a.reviewer.localeCompare(b.reviewer);
  });
  return cards;
}

function buildCardForReviewer(
  reviewer: string,
  rows: readonly PrDecision[],
  opts: { windowDays: number; reviewedAt: string },
): ReviewerCard {
  let merged = 0;
  let rejected = 0;
  let deferred = 0;
  const acceptBuckets = new Map<string, { count: number; example: PrDecision }>();
  const rejectBuckets = new Map<string, { count: number; example: PrDecision }>();

  for (const r of rows) {
    if (r.verdict === 'merged') merged += 1;
    else if (r.verdict === 'rejected') rejected += 1;
    else deferred += 1;

    if (!r.fingerprint) continue;
    const prefix = r.fingerprint.slice(0, FINGERPRINT_PREFIX_LEN);
    const bucket = r.verdict === 'merged' ? acceptBuckets : rejectBuckets;
    const existing = bucket.get(prefix);
    if (existing) {
      existing.count += 1;
      if (r.createdAt > existing.example.createdAt) existing.example = r;
    } else {
      bucket.set(prefix, { count: 1, example: r });
    }
  }

  const accept_patterns: ReviewerAcceptPattern[] = [...acceptBuckets.entries()]
    .map(([prefix, b]) => ({
      fingerprint_prefix: prefix,
      count: b.count,
      example_pr: prToUrl(b.example),
    }))
    .sort(comparePattern);

  const reject_patterns: ReviewerRejectPattern[] = [...rejectBuckets.entries()]
    .map(([prefix, b]) => ({
      fingerprint_prefix: prefix,
      count: b.count,
      example_pr: prToUrl(b.example),
      reason_hint: null,
    }))
    .sort(comparePattern);

  return {
    reviewer,
    window_days: opts.windowDays,
    reviewed_at: opts.reviewedAt,
    stats: { total_reviews: rows.length, merged, rejected, deferred },
    accept_patterns,
    reject_patterns,
    notes: '',
  };
}

function comparePattern(
  a: { fingerprint_prefix: string; count: number },
  b: { fingerprint_prefix: string; count: number },
): number {
  if (b.count !== a.count) return b.count - a.count;
  return a.fingerprint_prefix.localeCompare(b.fingerprint_prefix);
}

function prToUrl(d: PrDecision): string | null {
  if (!d.repo || !d.prNumber) return null;
  return `https://github.com/${d.repo}/pull/${d.prNumber}`;
}

/**
 * Load decisions from a TaskStore for the given repo+window. When `repo` is
 * omitted, falls back to the all-repos query. Filters in JS rather than SQL
 * because the store API exposes per-repo and we want a single window cutoff.
 */
function loadDecisions(opts: {
  dbPath: string;
  repo?: string;
  windowMs: number;
  now: number;
}): { rows: PrDecision[]; consideredRows: number } {
  const store = new TaskStore(opts.dbPath);
  try {
    const cutoff = opts.now - opts.windowMs;
    const raw = opts.repo
      ? store.getPrDecisionsByRepo(opts.repo, 10_000)
      : readAllDecisions(store);
    const rows = raw.filter((r) => r.createdAt >= cutoff && r.reviewerLogin !== null);
    return { rows, consideredRows: rows.length };
  } finally {
    store.close();
  }
}

function readAllDecisions(store: TaskStore): PrDecision[] {
  // Reach into the shared DB handle: `getPrDecisionsByRepo` is the only
  // public read path today, but the M4-T3 card pipeline genuinely wants
  // cross-repo. A dedicated `getAllPrDecisions` would be cleaner but is
  // out of scope for this PR (one concern: reviewer-pref pipeline).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: import('better-sqlite3').Database = (store as any).db;
  const rows = db
    .prepare(
      `SELECT id, task_id, repo, pr_number, verdict, reviewer_login, merged_at,
              created_at, fingerprint
         FROM pr_decisions
        ORDER BY created_at DESC, rowid DESC
        LIMIT 50000`,
    )
    .all() as Array<{
      id: string;
      task_id: string;
      repo: string;
      pr_number: number;
      verdict: string;
      reviewer_login: string | null;
      merged_at: number | null;
      created_at: number;
      fingerprint: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    repo: r.repo,
    prNumber: r.pr_number,
    verdict: r.verdict as PrDecision['verdict'],
    reviewerLogin: r.reviewer_login,
    mergedAt: r.merged_at,
    createdAt: r.created_at,
    fingerprint: r.fingerprint,
  }));
}

export function defaultPrefsDir(): string {
  return join(process.cwd(), '.ifleet', 'prefs');
}

export function reviewerCardPath(outDir: string, reviewer: string): string {
  // Reviewer handles are bounded by GitHub login rules ([A-Za-z0-9-], len<=39).
  // Conservative slug to defend against unusual logins from old data.
  const safe = reviewer.replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase();
  return join(outDir, `${safe}.json`);
}

export function writeReviewerCard(outDir: string, card: ReviewerCard): string {
  const path = reviewerCardPath(outDir, card.reviewer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(card, null, 2) + '\n');
  return path;
}

/**
 * Main entry. Read decisions, build cards, write top-N to disk, return both
 * the in-memory cards and the paths written.
 */
export function buildReviewerCards(opts: BuildReviewerCardsOptions = {}): BuildReviewerCardsResult {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const outDir = opts.outDir ?? defaultPrefsDir();
  const now = (opts.now ?? Date.now)();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  const decisions: readonly PrDecision[] = opts.decisions
    ? opts.decisions.filter(
        (d) => d.reviewerLogin && d.createdAt >= now - windowMs,
      )
    : loadDecisions({
        dbPath: opts.dbPath ?? defaultDbPath(),
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        windowMs,
        now,
      }).rows;

  const reviewedAt = new Date(now).toISOString();
  const cards = summariseReviewerDecisions(decisions, { windowDays, reviewedAt });
  const top = cards.slice(0, topN);
  const paths = top.map((c) => writeReviewerCard(outDir, c));
  return {
    cards: top,
    paths,
    reviewerCount: cards.length,
    consideredRows: decisions.length,
  };
}

function defaultDbPath(): string {
  // Importing `defaultTasksDbPath` directly would create a cycle through
  // store.ts → types.ts → here; inline the same shape.
  return (
    process.env['IFLEET_STATE_DIR']
      ? join(process.env['IFLEET_STATE_DIR']!, 'tasks.db')
      : join(process.cwd(), 'state', 'tasks.db')
  );
}
