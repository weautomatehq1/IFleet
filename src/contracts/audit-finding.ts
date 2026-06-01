// Canonical types and helpers for audit findings.
//
// Lives in `src/contracts/` so non-Discord consumers (pipeline runner,
// orchestrator, queue sources, audit store) can import without depending on
// the Discord module. `src/discord/audit-runner.ts` re-exports these names
// so existing import paths keep working.

export type AuditSeverity = 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';
export type AuditStatus = 'open' | 'fixing' | 'verifying' | 'reopened' | 'closed';

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  category: string;
  title: string;
  detail: string;
  file_globs: string[];
  fix_sketch: string;
  parallel_safe: boolean;
  fingerprint: string;
  status: AuditStatus;
  opened_at: string;
  closed_at: string | null;
  closing_pr: string | null;
}

export interface AuditIndex {
  repo: string;
  last_updated: string;
  open_findings: number;
  by_severity: Record<string, number>;
  findings: AuditFinding[];
}

// Audit finding ID prefix — all findings in .audits/index.json start with this.
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
