/**
 * Tests for the reviewer-prefs public surface (M4-T3 / M4-T4).
 *
 * `loadReviewerCard` is the architect-facing entry; it must return null on
 * missing files, parse a freshly-written card cleanly, and reject malformed
 * payloads so the architect sees a hard failure (not a partial card).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewerCard, writeReviewerCard, reviewerCardPath } from '../index.js';
import type { ReviewerCard } from '../index.js';

const FIXED_ISO = '2026-06-04T00:00:00.000Z';

function fixtureCard(over: Partial<ReviewerCard> = {}): ReviewerCard {
  return {
    reviewer: 'alice',
    window_days: 30,
    reviewed_at: FIXED_ISO,
    stats: { total_reviews: 2, merged: 1, rejected: 1, deferred: 0 },
    accept_patterns: [
      {
        fingerprint_prefix: '0123456789ab',
        count: 1,
        example_pr: 'https://github.com/weautomatehq1/IFleet/pull/1',
      },
    ],
    reject_patterns: [],
    notes: '',
    ...over,
  };
}

describe('loadReviewerCard', () => {
  it('returns the card when the file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefs-load-'));
    try {
      const card = fixtureCard();
      writeReviewerCard(tmp, card);
      const loaded = loadReviewerCard('alice', { prefsDir: tmp });
      expect(loaded).toEqual(card);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when the card file is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefs-missing-'));
    try {
      const loaded = loadReviewerCard('nobody', { prefsDir: tmp });
      expect(loaded).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('normalises mixed-case handles before lookup', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefs-case-'));
    try {
      writeReviewerCard(tmp, fixtureCard({ reviewer: 'Some-User' }));
      const loaded = loadReviewerCard('Some-User', { prefsDir: tmp });
      expect(loaded?.reviewer).toBe('Some-User');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws on a malformed card body (not a partial return)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'prefs-bad-'));
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(reviewerCardPath(tmp, 'alice'), JSON.stringify({ reviewer: 'alice' }));
      expect(() => loadReviewerCard('alice', { prefsDir: tmp })).toThrow(/malformed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
