// M6 — shadow-eval harness substrate types.
//
// Replays a stored eval-set row through the current architect + verifier
// seams (mockable DI) and compares the produced plan + verifier outcome
// against the expected output the row recorded. Emits per-row PASS/FAIL
// with a structured reason.
//
// SUBSTRATE ONLY — does NOT gate deploy. M6 closure wires the harness
// into the self-deploy preconditions.

/**
 * One row of `.ifleet/eval/eval-set.jsonl` — the frozen expected output
 * for a historical issue→PR pair. Schema inferred from the live file as
 * of 2026-06-16 (matches `.ifleet/eval/README.md`).
 */
export interface EvalRow {
  id: string;
  issue_url: string;
  pr_url: string;
  repo: string;
  title: string;
  body: string;
  classifier_label_actual: string;
  diff_url: string;
  diff_summary: string;
  files_changed: string[];
  loc_added: number;
  loc_removed: number;
  merged_at: string;
  reviewer_login: string;
  merge_decision: string;
  frozen_at: string;
}

/**
 * Projection of an {@link EvalRow} into the three fields the harness
 * compares: what files the editor was expected to touch, what the
 * classifier was expected to label it, what the verifier was expected
 * to decide. Anything else on the row (LOC counts, reviewer login) is
 * recorded for debugging but never compared — those are noisy signals.
 */
export interface ExpectedOutcome {
  filesChanged: string[];
  classifierLabel: string;
  mergeDecision: string;
}

/**
 * What the current architect + verifier surface produced this run.
 * Same shape as {@link ExpectedOutcome} so `compareEvalResult` is a
 * straight field-by-field diff.
 */
export interface ActualOutcome {
  filesChanged: string[];
  classifierLabel: string;
  mergeDecision: string;
}

export interface EvalResult {
  rowId: string;
  verdict: 'PASS' | 'FAIL';
  expected: ExpectedOutcome;
  actual: ActualOutcome;
  /** Populated on FAIL — names the first field that diverged. */
  reason?: string;
  durationMs: number;
}

export interface ShadowEvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalResult[];
  runStartedAt: string;
  runFinishedAt: string;
}
