import { describe, expect, it } from 'vitest';

import { planDriftPrs } from '../real-pr.js';
import type { DriftCandidate, DriftScanResult } from '../types.js';

function candidate(overrides: Partial<DriftCandidate> = {}): DriftCandidate {
  return {
    symbolKey: 'function:foo',
    name: 'foo',
    kind: 'function',
    driftKind: 'signature_skew',
    groups: [
      { signature: 'function foo(): void', repos: ['weautomatehq1/IFleet'], paths: ['src/a.ts'] },
      { signature: 'function foo(x: number): void', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
    ],
    outlierRepos: ['weautomatehq1/factory'],
    ...overrides,
  };
}

function result(candidates: DriftCandidate[]): DriftScanResult {
  return {
    scannedAt: '2026-06-16T02:00:00.000Z',
    reposScanned: ['weautomatehq1/IFleet', 'weautomatehq1/factory'],
    symbolsCompared: candidates.length,
    candidates,
    summary: { signature_skew: 0, rename_or_deletion: 0, orphan_reference: 0 },
  };
}

describe('planDriftPrs', () => {
  it('produces no plans for an empty scan', () => {
    expect(planDriftPrs(result([]))).toEqual([]);
  });

  it('groups candidates by source-of-truth repo (groups[0].repos[0])', () => {
    const plans = planDriftPrs(
      result([
        candidate({ name: 'foo', symbolKey: 'function:foo' }),
        candidate({ name: 'bar', symbolKey: 'function:bar' }),
      ]),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.sourceRepo).toBe('weautomatehq1/IFleet');
    expect(plans[0]!.candidates).toHaveLength(2);
    expect(plans[0]!.targetRepos).toEqual(['weautomatehq1/factory']);
    expect(plans[0]!.title).toContain('weautomatehq1/IFleet');
    expect(plans[0]!.body).toContain('Source of truth');
  });

  it('emits one plan per distinct source-of-truth repo, sorted', () => {
    const plans = planDriftPrs(
      result([
        candidate({
          name: 'a',
          symbolKey: 'function:a',
          groups: [
            { signature: 's1', repos: ['weautomatehq1/IFleet'], paths: ['x.ts'] },
            { signature: 's2', repos: ['weautomatehq1/factory'], paths: ['y.ts'] },
          ],
          outlierRepos: ['weautomatehq1/factory'],
        }),
        candidate({
          name: 'b',
          symbolKey: 'function:b',
          groups: [
            { signature: 's3', repos: ['weautomatehq1/factory'], paths: ['p.ts'] },
            { signature: 's4', repos: ['weautomatehq1/IFleet'], paths: ['q.ts'] },
          ],
          outlierRepos: ['weautomatehq1/IFleet'],
        }),
      ]),
    );
    expect(plans.map((p) => p.sourceRepo)).toEqual([
      'weautomatehq1/IFleet',
      'weautomatehq1/factory',
    ]);
  });

  it('skips candidates with no resolvable source repo', () => {
    const plans = planDriftPrs(
      result([candidate({ groups: [], outlierRepos: [] })]),
    );
    expect(plans).toEqual([]);
  });
});
