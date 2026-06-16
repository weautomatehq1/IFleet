import { describe, expect, it } from 'vitest';

import { compareEvalResult, replayRow, type ReplayDeps } from '../replay.js';
import type { EvalRow } from '../types.js';

function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'ifleet-IF-001',
    issue_url: 'https://github.com/weautomatehq1/IFleet/issues/1',
    pr_url: 'https://github.com/weautomatehq1/IFleet/pull/2',
    repo: 'weautomatehq1/IFleet',
    title: 'Fix foo',
    body: 'detail',
    classifier_label_actual: 'bugfix',
    diff_url: 'https://example.com/diff',
    diff_summary: 'fixed foo',
    files_changed: ['src/foo.ts', 'src/__tests__/foo.test.ts'],
    loc_added: 10,
    loc_removed: 3,
    merged_at: '2026-05-19T10:00:00Z',
    reviewer_login: 'monstersebas1',
    merge_decision: 'merged_no_changes',
    frozen_at: '2026-05-19T20:00:00Z',
    ...overrides,
  };
}

describe('compareEvalResult', () => {
  const expected = {
    filesChanged: ['src/foo.ts', 'src/__tests__/foo.test.ts'],
    classifierLabel: 'bugfix',
    mergeDecision: 'merged_no_changes',
  };

  it('returns PASS when every field matches exactly', () => {
    const out = compareEvalResult(expected, { ...expected });
    expect(out).toEqual({ verdict: 'PASS' });
  });

  it('returns PASS when filesChanged differ only in order', () => {
    const out = compareEvalResult(expected, {
      ...expected,
      filesChanged: ['src/__tests__/foo.test.ts', 'src/foo.ts'],
    });
    expect(out).toEqual({ verdict: 'PASS' });
  });

  it('returns FAIL with reason naming classifierLabel when label differs', () => {
    const out = compareEvalResult(expected, { ...expected, classifierLabel: 'feature' });
    expect(out.verdict).toBe('FAIL');
    expect(out.reason).toMatch(/classifierLabel/);
    expect(out.reason).toContain('expected=bugfix');
    expect(out.reason).toContain('actual=feature');
  });

  it('returns FAIL naming filesChanged when set differs', () => {
    const out = compareEvalResult(expected, {
      ...expected,
      filesChanged: ['src/foo.ts'],
    });
    expect(out.verdict).toBe('FAIL');
    expect(out.reason).toMatch(/filesChanged/);
  });

  it('returns FAIL naming mergeDecision when verifier outcome differs', () => {
    const out = compareEvalResult(expected, { ...expected, mergeDecision: 'closed_no_merge' });
    expect(out.verdict).toBe('FAIL');
    expect(out.reason).toMatch(/mergeDecision/);
    expect(out.reason).toContain('actual=closed_no_merge');
  });

  it('reports classifierLabel before filesChanged when both differ (stable precedence)', () => {
    const out = compareEvalResult(expected, {
      classifierLabel: 'feature',
      filesChanged: [],
      mergeDecision: 'closed_no_merge',
    });
    expect(out.verdict).toBe('FAIL');
    expect(out.reason).toMatch(/classifierLabel/);
  });
});

describe('replayRow', () => {
  function deps(
    archResult: { filesChanged: string[]; classifierLabel: string },
    verResult: { mergeDecision: string },
  ): ReplayDeps {
    let n = 0;
    return {
      architect: { async plan() { return archResult; } },
      verifier: { async verify() { return verResult; } },
      now: () => {
        n += 5;
        return n;
      },
    };
  }

  it('emits PASS when both seams reproduce the recorded outcome', async () => {
    const row = makeRow();
    const result = await replayRow(
      row,
      deps(
        { filesChanged: row.files_changed, classifierLabel: row.classifier_label_actual },
        { mergeDecision: row.merge_decision },
      ),
    );
    expect(result.rowId).toBe(row.id);
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toBeUndefined();
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.expected.classifierLabel).toBe('bugfix');
    expect(result.actual.classifierLabel).toBe('bugfix');
  });

  it('emits FAIL with reason when verifier seam diverges from the recorded outcome', async () => {
    const row = makeRow();
    const result = await replayRow(
      row,
      deps(
        { filesChanged: row.files_changed, classifierLabel: row.classifier_label_actual },
        { mergeDecision: 'closed_no_merge' },
      ),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.reason).toMatch(/mergeDecision/);
    expect(result.actual.mergeDecision).toBe('closed_no_merge');
  });

  it('emits FAIL when architect seam returns a different classifier label', async () => {
    const row = makeRow();
    const result = await replayRow(
      row,
      deps(
        { filesChanged: row.files_changed, classifierLabel: 'feature' },
        { mergeDecision: row.merge_decision },
      ),
    );
    expect(result.verdict).toBe('FAIL');
    expect(result.reason).toMatch(/classifierLabel/);
  });
});
