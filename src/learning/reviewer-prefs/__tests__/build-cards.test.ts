/**
 * Tests for the reviewer-prefs card pipeline (M4-T3).
 *
 * Exercises the pure summarisation, idempotency on disk, and the DB-backed
 * top-N round trip. Uses tmpdir + an in-process TaskStore so no external
 * services are touched.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../../queue/store.js';
import {
  buildReviewerCards,
  defaultPrefsDir,
  reviewerCardPath,
  summariseReviewerDecisions,
  writeReviewerCard,
} from '../build-cards.js';
import type { PrDecision } from '../../../queue/store.js';

const FIXED_NOW = 1_700_000_000_000;
const FIXED_ISO = new Date(FIXED_NOW).toISOString();

function makeDecision(over: Partial<PrDecision>): PrDecision {
  return {
    id: 'd1',
    taskId: 't1',
    repo: 'weautomatehq1/IFleet',
    prNumber: 1,
    verdict: 'merged',
    reviewerLogin: 'alice',
    mergedAt: FIXED_NOW,
    createdAt: FIXED_NOW - 1000,
    fingerprint: 'a'.repeat(64),
    ...over,
  };
}

describe('summariseReviewerDecisions', () => {
  it('groups decisions by reviewer and ranks by total_reviews', () => {
    const cards = summariseReviewerDecisions(
      [
        makeDecision({ id: '1', reviewerLogin: 'alice' }),
        makeDecision({ id: '2', reviewerLogin: 'alice', verdict: 'rejected', prNumber: 2 }),
        makeDecision({ id: '3', reviewerLogin: 'bob', prNumber: 3 }),
      ],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    expect(cards.map((c) => c.reviewer)).toEqual(['alice', 'bob']);
    expect(cards[0]?.stats).toEqual({
      total_reviews: 2,
      merged: 1,
      rejected: 1,
      deferred: 0,
    });
  });

  it('breaks ties by reviewer name ascending for idempotency', () => {
    const cards = summariseReviewerDecisions(
      [
        makeDecision({ id: '1', reviewerLogin: 'zoe', prNumber: 1 }),
        makeDecision({ id: '2', reviewerLogin: 'alice', prNumber: 2 }),
      ],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    expect(cards.map((c) => c.reviewer)).toEqual(['alice', 'zoe']);
  });

  it('skips decisions with null reviewer_login', () => {
    const cards = summariseReviewerDecisions(
      [
        makeDecision({ id: '1', reviewerLogin: null }),
        makeDecision({ id: '2', reviewerLogin: 'alice' }),
      ],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.reviewer).toBe('alice');
  });

  it('buckets accept/reject patterns by 12-char fingerprint prefix', () => {
    const fpA = '1234567890ab' + 'c'.repeat(52);
    const fpB = '1234567890ab' + 'd'.repeat(52);
    const fpC = 'fedcba098765' + 'f'.repeat(52);
    const cards = summariseReviewerDecisions(
      [
        makeDecision({ id: '1', prNumber: 1, fingerprint: fpA, verdict: 'merged' }),
        makeDecision({ id: '2', prNumber: 2, fingerprint: fpB, verdict: 'merged' }),
        makeDecision({ id: '3', prNumber: 3, fingerprint: fpC, verdict: 'rejected' }),
      ],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    const card = cards[0]!;
    expect(card.accept_patterns).toEqual([
      {
        fingerprint_prefix: '1234567890ab',
        count: 2,
        example_pr: expect.stringMatching(/\/pull\/[12]$/),
      },
    ]);
    expect(card.reject_patterns).toEqual([
      {
        fingerprint_prefix: 'fedcba098765',
        count: 1,
        example_pr: 'https://github.com/weautomatehq1/IFleet/pull/3',
        reason_hint: null,
      },
    ]);
  });

  it('drops fingerprintless rows from pattern arrays but still counts them in stats', () => {
    const cards = summariseReviewerDecisions(
      [
        makeDecision({ id: '1', prNumber: 1, fingerprint: null, verdict: 'merged' }),
        makeDecision({ id: '2', prNumber: 2, fingerprint: 'a'.repeat(64), verdict: 'merged' }),
      ],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    const card = cards[0]!;
    expect(card.stats.total_reviews).toBe(2);
    expect(card.stats.merged).toBe(2);
    expect(card.accept_patterns).toHaveLength(1);
  });

  it('classifies abandoned verdicts as deferred', () => {
    const cards = summariseReviewerDecisions(
      [makeDecision({ verdict: 'abandoned' })],
      { windowDays: 30, reviewedAt: FIXED_ISO },
    );
    expect(cards[0]?.stats.deferred).toBe(1);
  });
});

describe('writeReviewerCard / disk round-trip', () => {
  it('writes deterministic JSON bytes when input + reviewedAt are fixed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reviewer-prefs-'));
    try {
      const cards = summariseReviewerDecisions(
        [
          makeDecision({ id: '1', prNumber: 1, fingerprint: 'a'.repeat(64) }),
          makeDecision({ id: '2', prNumber: 2, fingerprint: 'b'.repeat(64) }),
        ],
        { windowDays: 30, reviewedAt: FIXED_ISO },
      );
      const p1 = writeReviewerCard(tmp, cards[0]!);
      const b1 = readFileSync(p1);
      const p2 = writeReviewerCard(tmp, cards[0]!);
      const b2 = readFileSync(p2);
      expect(b2.equals(b1)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('normalises reviewer handles to safe filenames', () => {
    const path = reviewerCardPath('/x', 'Some-User');
    expect(path).toBe('/x/some-user.json');
  });
});

describe('buildReviewerCards (DB-backed)', () => {
  it('reads the TaskStore, filters by window, writes top-N cards', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reviewer-prefs-db-'));
    const dbPath = join(tmp, 'tasks.db');
    const outDir = join(tmp, 'prefs');

    const store = new TaskStore(dbPath);
    // seed a task so the FK passes
    seedTask(store, 't-1');
    seedTask(store, 't-2');
    seedTask(store, 't-3');
    seedTask(store, 't-old');

    const recent = FIXED_NOW - 1000;
    const old = FIXED_NOW - 60 * 24 * 60 * 60 * 1000; // 60d ago
    // alice: 2 reviews recent, 1 old
    store.recordPrDecision({
      taskId: 't-1',
      repo: 'weautomatehq1/IFleet',
      prNumber: 101,
      verdict: 'merged',
      reviewerLogin: 'alice',
      mergedAt: recent,
      fingerprint: 'a'.repeat(64),
    });
    store.recordPrDecision({
      taskId: 't-2',
      repo: 'weautomatehq1/IFleet',
      prNumber: 102,
      verdict: 'rejected',
      reviewerLogin: 'alice',
      fingerprint: 'b'.repeat(64),
    });
    store.recordPrDecision({
      taskId: 't-old',
      repo: 'weautomatehq1/IFleet',
      prNumber: 999,
      verdict: 'merged',
      reviewerLogin: 'alice',
      mergedAt: old,
      fingerprint: 'c'.repeat(64),
    });
    // Mutate the old row's created_at directly — `recordPrDecision` stamps now().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    db.prepare(`UPDATE pr_decisions SET created_at = @t WHERE pr_number = 999`).run({ t: old });

    // bob: 1 review recent
    store.recordPrDecision({
      taskId: 't-3',
      repo: 'weautomatehq1/IFleet',
      prNumber: 103,
      verdict: 'merged',
      reviewerLogin: 'bob',
      fingerprint: 'd'.repeat(64),
    });
    store.close();

    const result = buildReviewerCards({
      dbPath,
      outDir,
      windowDays: 30,
      topN: 3,
      now: () => FIXED_NOW,
    });

    expect(result.cards.map((c) => c.reviewer)).toEqual(['alice', 'bob']);
    expect(result.cards[0]?.stats.total_reviews).toBe(2);
    expect(result.cards[1]?.stats.total_reviews).toBe(1);
    expect(existsSync(reviewerCardPath(outDir, 'alice'))).toBe(true);
    expect(existsSync(reviewerCardPath(outDir, 'bob'))).toBe(true);
    expect(result.consideredRows).toBe(3); // old row excluded

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('defaultPrefsDir', () => {
  it('resolves to a path ending in .ifleet/prefs', () => {
    expect(defaultPrefsDir()).toMatch(/\.ifleet\/prefs$/);
  });
});

function seedTask(store: TaskStore, id: string): void {
  store.insert({
    id,
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: 'N',
      url: 'https://github.com/weautomatehq1/IFleet/issues/1',
    },
    repo: 'weautomatehq1/IFleet',
    brief: 'b',
    title: 't',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    state: 'pending',
    idempotencyKey: `key-${id}`,
    createdAt: FIXED_NOW - 10_000,
  });
}
