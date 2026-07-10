// Audit-fix tag — the `[audit-fix:<id>]` brief prefix that couples /audit-fix
// dispatch to pipeline close-out. Multiple consumers (pipeline runner,
// orchestrator, queue/sources/discord) need to parse this; centralizing here
// keeps the regex from drifting across copies.
//
// Lives in orchestrator-core (rather than IFleet's audit/types.ts) because the
// extracted queue source `sources/discord.ts` decorates completion messages
// with the finding id. It is a pure string leaf with zero deps. IFleet's
// `audit/types.ts` re-exports these so existing app import sites keep resolving.

/** Audit finding ID prefix — all findings in `.audits/index.json` start with this. */
export const AUDIT_ID_PREFIX = 'AUDIT-';

/**
 * Regex that recognises an audit-fix task. `/audit-fix` prefixes every
 * synthesized brief with `[audit-fix:<finding id>]`; the pipeline runner and
 * any other completion-side consumers use this to know a completed task
 * should close a finding in `index.json`.
 */
export const AUDIT_FIX_GOAL_RE = new RegExp(`\\[audit-fix:(${AUDIT_ID_PREFIX}[^\\]]+)\\]`);

/** Extract the finding id from an audit-fix task goal, or `null` if absent. */
export function extractAuditFindingId(goal: string): string | null {
  return goal.match(AUDIT_FIX_GOAL_RE)?.[1] ?? null;
}
