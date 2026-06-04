/**
 * get_reviewer_prefs tool tests (M4-T4).
 *
 * Exercises the architect's tool-registry path end-to-end: write a fixture
 * card to a temp prefs dir, look it up via the tool, verify the architect
 * sees the same shape it would in production. Also verifies the
 * null-on-missing contract and the registry exposure.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getReviewerPrefs } from '../get_reviewer_prefs.js';
import { writeReviewerCard } from '../../../../learning/reviewer-prefs/index.js';
import type { ReviewerCard } from '../../../../learning/reviewer-prefs/index.js';
import { ARCHITECT_TOOLS } from '../index.js';

const FIXED_ISO = '2026-06-04T00:00:00.000Z';

function fixtureCard(over: Partial<ReviewerCard> = {}): ReviewerCard {
  return {
    reviewer: 'sebastian',
    window_days: 30,
    reviewed_at: FIXED_ISO,
    stats: { total_reviews: 5, merged: 4, rejected: 1, deferred: 0 },
    accept_patterns: [
      {
        fingerprint_prefix: '0123456789ab',
        count: 3,
        example_pr: 'https://github.com/weautomatehq1/IFleet/pull/100',
      },
    ],
    reject_patterns: [
      {
        fingerprint_prefix: 'fedcba987654',
        count: 1,
        example_pr: 'https://github.com/weautomatehq1/IFleet/pull/101',
        reason_hint: null,
      },
    ],
    notes: 'prefers small surgical PRs',
    ...over,
  };
}

describe('get_reviewer_prefs', () => {
  it('returns the fixture card the architect would consume', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-prefs-'));
    try {
      const card = fixtureCard();
      writeReviewerCard(tmp, card);
      const result = await getReviewerPrefs('sebastian', { prefsDir: tmp });
      expect(result).toEqual(card);
      expect(result?.accept_patterns[0]?.fingerprint_prefix).toBe('0123456789ab');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null (not throw) when the handle has no card on disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-prefs-missing-'));
    try {
      const result = await getReviewerPrefs('nobody-ever-reviewed', { prefsDir: tmp });
      expect(result).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects empty / non-string reviewer arguments', async () => {
    await expect(getReviewerPrefs('')).rejects.toThrow(/non-empty/);
    await expect(getReviewerPrefs('   ')).rejects.toThrow(/non-empty/);
  });

  it('honours an injected loader (no disk I/O)', async () => {
    const inMemory = fixtureCard({ reviewer: 'octocat', notes: 'fake' });
    const result = await getReviewerPrefs('octocat', {
      loader: (r) => (r === 'octocat' ? inMemory : null),
    });
    expect(result?.notes).toBe('fake');
  });
});

describe('architect tool registry', () => {
  it('exposes get_reviewer_prefs alongside query_code_graph', () => {
    const names = ARCHITECT_TOOLS.map((t) => t.name);
    expect(names).toContain('get_reviewer_prefs');
    expect(names).toContain('query_code_graph');
  });

  it('invoking the registry entry yields the same result as a direct call', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'arch-prefs-reg-'));
    try {
      const card = fixtureCard({ reviewer: 'esmel' });
      writeReviewerCard(tmp, card);
      const entry = ARCHITECT_TOOLS.find((t) => t.name === 'get_reviewer_prefs');
      expect(entry).toBeDefined();
      const viaRegistry = await entry!.fn('esmel', { prefsDir: tmp });
      const direct = await getReviewerPrefs('esmel', { prefsDir: tmp });
      expect(viaRegistry).toEqual(direct);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
