// Deprecated shim — kept for one release. Re-exports the diff-reviewer at
// its new home. New code should import from './diff-reviewer.js' directly.
// Remove this file after the next release cuts.
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
