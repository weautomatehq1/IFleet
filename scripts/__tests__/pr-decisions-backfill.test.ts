import { describe, it, expect } from 'vitest';
import {
  classifyVerdict,
  pickReviewerLogin,
  parseTimestamp,
  mapPullRequest,
  mapPullRequests,
  type GhPullRequest,
} from '../lib/pr-decisions-backfill.ts';

function pr(overrides: Partial<GhPullRequest> = {}): GhPullRequest {
  return {
    url: 'https://github.com/weautomatehq1/IFleet/pull/100',
    number: 100,
    state: 'MERGED',
    mergedAt: '2026-05-20T10:00:00Z',
    closedAt: '2026-05-20T10:00:00Z',
    author: { login: 'monstersebas1' },
    reviews: [],
    ...overrides,
  };
}

describe('classifyVerdict', () => {
  it('returns merged when state=MERGED', () => {
    expect(classifyVerdict(pr({ state: 'MERGED' }))).toBe('merged');
  });

  it('returns merged when mergedAt is set even if state says otherwise', () => {
    expect(classifyVerdict(pr({ state: 'CLOSED', mergedAt: '2026-05-20T10:00:00Z' }))).toBe(
      'merged',
    );
  });

  it('returns null (skip) for open PRs', () => {
    expect(classifyVerdict(pr({ state: 'OPEN', mergedAt: null }))).toBeNull();
  });

  it('returns rejected for closed-unmerged with a CHANGES_REQUESTED review', () => {
    const p = pr({
      state: 'CLOSED',
      mergedAt: null,
      reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'alice' } }],
    });
    expect(classifyVerdict(p)).toBe('rejected');
  });

  it('returns abandoned for closed-unmerged with no negative review', () => {
    const p = pr({ state: 'CLOSED', mergedAt: null, reviews: [] });
    expect(classifyVerdict(p)).toBe('abandoned');
  });

  it('returns abandoned when only DISMISSED reviews exist (no live CHANGES_REQUESTED)', () => {
    const p = pr({
      state: 'CLOSED',
      mergedAt: null,
      reviews: [{ state: 'DISMISSED', author: { login: 'alice' } }],
    });
    expect(classifyVerdict(p)).toBe('abandoned');
  });

  it('ignores bot CHANGES_REQUESTED reviews when classifying closed PRs', () => {
    const p = pr({
      state: 'CLOSED',
      mergedAt: null,
      reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'codex-bot[bot]' } }],
    });
    expect(classifyVerdict(p)).toBe('abandoned');
  });

  it('treats approved-then-closed (unusual) as abandoned, not rejected', () => {
    const p = pr({
      state: 'CLOSED',
      mergedAt: null,
      reviews: [{ state: 'APPROVED', author: { login: 'alice' } }],
    });
    expect(classifyVerdict(p)).toBe('abandoned');
  });
});

describe('pickReviewerLogin', () => {
  it('returns the latest non-bot reviewer with a concrete verdict', () => {
    const p = pr({
      reviews: [
        {
          state: 'APPROVED',
          author: { login: 'alice' },
          submittedAt: '2026-05-01T00:00:00Z',
        },
        {
          state: 'CHANGES_REQUESTED',
          author: { login: 'bob' },
          submittedAt: '2026-05-02T00:00:00Z',
        },
      ],
    });
    expect(pickReviewerLogin(p)).toBe('bob');
  });

  it('ignores bot reviews (detected via `[bot]` login suffix)', () => {
    const p = pr({
      reviews: [
        {
          state: 'APPROVED',
          author: { login: 'dependabot[bot]' },
          submittedAt: '2026-05-02T00:00:00Z',
        },
        {
          state: 'APPROVED',
          author: { login: 'alice' },
          submittedAt: '2026-05-01T00:00:00Z',
        },
      ],
    });
    expect(pickReviewerLogin(p)).toBe('alice');
  });

  it('ignores plain COMMENTED reviews without verdict', () => {
    const p = pr({
      reviews: [
        { state: 'COMMENTED', author: { login: 'alice' } },
      ],
    });
    expect(pickReviewerLogin(p)).toBeUndefined();
  });

  it('returns undefined when there are no reviews', () => {
    expect(pickReviewerLogin(pr({ reviews: [] }))).toBeUndefined();
  });
});

describe('parseTimestamp', () => {
  it('parses ISO to epoch ms', () => {
    expect(parseTimestamp('2026-05-20T10:00:00Z')).toBe(Date.parse('2026-05-20T10:00:00Z'));
  });

  it('returns undefined for null/undefined/invalid', () => {
    expect(parseTimestamp(null)).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
    expect(parseTimestamp('not-a-date')).toBeUndefined();
  });
});

describe('mapPullRequest', () => {
  it('produces a RecordPrDecisionInput with sentinel task_id for backfill', () => {
    const p = pr({ number: 171, url: 'https://github.com/weautomatehq1/IFleet/pull/171' });
    const result = mapPullRequest(p, 'weautomatehq1/IFleet');
    if ('skipped' in result) throw new Error('expected mapped, got skipped');
    expect(result.input.taskId).toBe('backfill:https://github.com/weautomatehq1/IFleet/pull/171');
    expect(result.input.repo).toBe('weautomatehq1/IFleet');
    expect(result.input.prNumber).toBe(171);
    expect(result.input.verdict).toBe('merged');
    expect(result.input.mergedAt).toBe(Date.parse('2026-05-20T10:00:00Z'));
  });

  it('skips open PRs', () => {
    const result = mapPullRequest(pr({ state: 'OPEN', mergedAt: null }), 'weautomatehq1/IFleet');
    expect('skipped' in result).toBe(true);
  });
});

describe('mapPullRequests', () => {
  it('partitions mapped vs skipped', () => {
    const out = mapPullRequests(
      [
        pr({ number: 1, state: 'MERGED' }),
        pr({ number: 2, state: 'OPEN', mergedAt: null }),
        pr({
          number: 3,
          state: 'CLOSED',
          mergedAt: null,
          reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'alice' } }],
        }),
      ],
      'weautomatehq1/IFleet',
    );
    expect(out.mapped).toHaveLength(2);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.pr.number).toBe(2);
    expect(out.mapped.map((m) => m.input.verdict)).toEqual(['merged', 'rejected']);
  });
});
