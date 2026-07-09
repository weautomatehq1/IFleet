// Deprecated shim — kept for one release. Re-exports the diff-reviewer at
// its new home. New code should import from './diff-reviewer.js' directly.
// Remove by 2026-09-01 once all internal callers have migrated.
export {
  runReviewer,
  assertCrossProviderRule,
  CrossProviderRuleViolation,
  parseGateOutput,
  parseVerdict,
  type GateDecision,
  type RunReviewerInput,
  type ReviewerOutput,
} from './diff-reviewer.js';
