import { describe, expect, it } from 'vitest';

import {
  computeDriftSignature,
  computeIdempotencyKey,
  computeSourceFileSha,
  DRIFT_AUDIT_LABEL,
  planDriftPrs,
} from '../real-pr.js';
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

  it('every emitted plan carries the audit:drift label', () => {
    const plans = planDriftPrs(
      result([
        candidate({ name: 'a', symbolKey: 'function:a' }),
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
    expect(plans).toHaveLength(2);
    for (const p of plans) {
      expect(p.labels).toContain(DRIFT_AUDIT_LABEL);
      expect(p.labels).toEqual(['audit:drift']);
    }
  });

  it('every emitted plan carries a stable idempotencyKey', () => {
    const plans = planDriftPrs(
      result([candidate({ name: 'foo', symbolKey: 'function:foo' })]),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('idempotencyKey determinism', () => {
  it('identical scans → identical idempotencyKey', () => {
    const c = candidate({ name: 'foo', symbolKey: 'function:foo' });
    const a = planDriftPrs(result([c]))[0]!.idempotencyKey;
    const b = planDriftPrs(result([c]))[0]!.idempotencyKey;
    expect(a).toBe(b);
  });

  it('different drift signature → different idempotencyKey', () => {
    const baseline = planDriftPrs(
      result([
        candidate({
          name: 'foo',
          symbolKey: 'function:foo',
          groups: [
            { signature: 'function foo(): void', repos: ['weautomatehq1/IFleet'], paths: ['src/a.ts'] },
            { signature: 'function foo(x: number): void', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
          ],
        }),
      ]),
    )[0]!.idempotencyKey;

    const drifted = planDriftPrs(
      result([
        candidate({
          name: 'foo',
          symbolKey: 'function:foo',
          groups: [
            { signature: 'function foo(opts: Opts): void', repos: ['weautomatehq1/IFleet'], paths: ['src/a.ts'] },
            { signature: 'function foo(x: number): void', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
          ],
        }),
      ]),
    )[0]!.idempotencyKey;

    expect(baseline).not.toBe(drifted);
  });

  it('different source-file paths → different idempotencyKey', () => {
    const a = planDriftPrs(
      result([
        candidate({
          name: 'foo',
          symbolKey: 'function:foo',
          groups: [
            { signature: 's', repos: ['weautomatehq1/IFleet'], paths: ['src/a.ts'] },
            { signature: 's2', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
          ],
        }),
      ]),
    )[0]!.idempotencyKey;

    const b = planDriftPrs(
      result([
        candidate({
          name: 'foo',
          symbolKey: 'function:foo',
          groups: [
            { signature: 's', repos: ['weautomatehq1/IFleet'], paths: ['src/A_RENAMED.ts'] },
            { signature: 's2', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
          ],
        }),
      ]),
    )[0]!.idempotencyKey;

    expect(a).not.toBe(b);
  });

  it('candidate order does NOT change idempotencyKey', () => {
    const c1 = candidate({ name: 'a', symbolKey: 'function:a' });
    const c2 = candidate({
      name: 'b',
      symbolKey: 'function:b',
      groups: [
        { signature: 's3', repos: ['weautomatehq1/IFleet'], paths: ['p.ts'] },
        { signature: 's4', repos: ['weautomatehq1/factory'], paths: ['q.ts'] },
      ],
      outlierRepos: ['weautomatehq1/factory'],
    });
    const forward = planDriftPrs(result([c1, c2]))[0]!.idempotencyKey;
    const reverse = planDriftPrs(result([c2, c1]))[0]!.idempotencyKey;
    expect(forward).toBe(reverse);
  });

  it('exposed helpers compose into the final key', () => {
    const cands = [candidate({ name: 'foo', symbolKey: 'function:foo' })];
    const sourceFileSha = computeSourceFileSha('weautomatehq1/IFleet', cands);
    const driftSignature = computeDriftSignature(cands);
    const composed = computeIdempotencyKey('weautomatehq1/IFleet', cands);
    expect(sourceFileSha).toMatch(/^[a-f0-9]{64}$/);
    expect(driftSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(composed).toMatch(/^[a-f0-9]{64}$/);
    // sanity: the three are distinct so we can detect a regression where
    // computeIdempotencyKey accidentally short-circuits to one of them.
    expect(composed).not.toBe(sourceFileSha);
    expect(composed).not.toBe(driftSignature);
  });
});
