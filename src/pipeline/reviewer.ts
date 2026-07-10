// Deprecated shim — kept for one release cycle after the diff-reviewer rename.
// New code must import from './diff-reviewer.js' directly.
// TODO(remove-by:2026-09-01): delete this file once all callers migrated.
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
