// M6 — single-row replay + pure comparator.

import type {
  ActualOutcome,
  EvalResult,
  EvalRow,
  ExpectedOutcome,
} from './types.js';

/**
 * Architect seam — produces a plan for an eval row. The plan shape is
 * just the two fields the harness compares; the real architect surface
 * (`src/agents/architect/`) returns much more, but the substrate only
 * cares about what's directly comparable to a frozen eval row.
 *
 * Mockable via DI in tests. M6 closure wires this to a thin adapter on
 * the real architect module.
 */
export interface ArchitectSeam {
  plan(row: EvalRow): Promise<{ filesChanged: string[]; classifierLabel: string }>;
}

/**
 * Verifier seam — given the architect's plan, returns the merge
 * decision the verifier would produce. Mockable via DI. M6 closure
 * wires this to `src/agents/verifier/`.
 */
export interface VerifierSeam {
  verify(
    plan: { filesChanged: string[]; classifierLabel: string },
    row: EvalRow,
  ): Promise<{ mergeDecision: string }>;
}

export interface ReplayDeps {
  architect: ArchitectSeam;
  verifier: VerifierSeam;
  /** Override the clock — tests inject a monotonic counter for deterministic durationMs. */
  now?: () => number;
}

/**
 * Pure comparator. Returns PASS iff every compared field matches;
 * otherwise FAIL with a reason naming the FIRST diverging field
 * (classifierLabel → filesChanged → mergeDecision). The fixed
 * precedence keeps reason strings stable across runs.
 *
 * `filesChanged` is order-independent: the architect can list files
 * in any order without flagging drift.
 */
export function compareEvalResult(
  expected: ExpectedOutcome,
  actual: ActualOutcome,
): { verdict: 'PASS' | 'FAIL'; reason?: string } {
  if (actual.classifierLabel !== expected.classifierLabel) {
    return {
      verdict: 'FAIL',
      reason: `classifierLabel mismatch: expected=${expected.classifierLabel} actual=${actual.classifierLabel}`,
    };
  }
  const e = [...expected.filesChanged].sort();
  const a = [...actual.filesChanged].sort();
  if (e.length !== a.length || e.some((f, i) => f !== a[i])) {
    return {
      verdict: 'FAIL',
      reason: `filesChanged mismatch: expected=[${e.join(',')}] actual=[${a.join(',')}]`,
    };
  }
  if (actual.mergeDecision !== expected.mergeDecision) {
    return {
      verdict: 'FAIL',
      reason: `mergeDecision mismatch: expected=${expected.mergeDecision} actual=${actual.mergeDecision}`,
    };
  }
  return { verdict: 'PASS' };
}

export async function replayRow(row: EvalRow, deps: ReplayDeps): Promise<EvalResult> {
  const now = deps.now ?? ((): number => Date.now());
  const start = now();

  const expected: ExpectedOutcome = {
    filesChanged: row.files_changed,
    classifierLabel: row.classifier_label_actual,
    mergeDecision: row.merge_decision,
  };

  const plan = await deps.architect.plan(row);
  const verify = await deps.verifier.verify(plan, row);

  const actual: ActualOutcome = {
    filesChanged: plan.filesChanged,
    classifierLabel: plan.classifierLabel,
    mergeDecision: verify.mergeDecision,
  };

  const cmp = compareEvalResult(expected, actual);
  const durationMs = now() - start;

  return cmp.verdict === 'PASS'
    ? { rowId: row.id, verdict: 'PASS', expected, actual, durationMs }
    : { rowId: row.id, verdict: 'FAIL', expected, actual, reason: cmp.reason, durationMs };
}
