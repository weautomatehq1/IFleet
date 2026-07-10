// Canonical audit-finding types. Both the Discord runner (`src/discord/audit-runner.ts`)
// and the Supabase store (`src/audit/audit-store.ts`) import from here so the two
// surfaces can't drift on status enums or rollup shape.

export type AuditSeverity = 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';

export type AuditStatus =
  | 'open'
  | 'fixing'
  | 'verifying'
  | 'reopened'
  | 'closed'
  | 'fixed'
  | 'stale';

export const AUDIT_STATUSES: readonly AuditStatus[] = [
  'open',
  'fixing',
  'verifying',
  'reopened',
  'closed',
  'fixed',
  'stale',
];

/**
 * Statuses that a finding cannot transition out of via Discord commands or
 * pipeline auto-mutations. `fixed` — set when a PR references the finding ID
 * via markFindingsClosed with status:'fixed'; `closed` — set by the pipeline
 * runner or markFindingClosed; `stale` — set by manual cleanup of findings
 * whose underlying code is gone. Once a finding is in any of these states, a
 * new /audit-scan must surface its fingerprint again (as a fresh id) to
 * reopen it.
 */
export const TERMINAL_AUDIT_STATUSES: readonly AuditStatus[] = ['closed', 'fixed', 'stale'];

export function isTerminalAuditStatus(status: AuditStatus): boolean {
  return (TERMINAL_AUDIT_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that count toward `open_findings` and `by_severity` in the rollup.
 * Findings that are mid-pipeline (`fixing`, `verifying`) are tracked but not
 * counted as actionable — `openFindings()` and rollups must agree on this set
 * or local/Supabase counts will diverge (see AUDIT-IFleet-ab40871b).
 */
export const ACTIVE_AUDIT_STATUSES: readonly AuditStatus[] = ['open', 'reopened'];

export function isActiveAuditStatus(status: AuditStatus): boolean {
  return (ACTIVE_AUDIT_STATUSES as readonly string[]).includes(status);
}

export const AUDIT_SEVERITIES: readonly AuditSeverity[] = [
  'CRITICAL',
  'IMPORTANT',
  'COSMETIC',
];

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
  by_severity: Record<AuditSeverity, number>;
  findings: AuditFinding[];
}

export function emptyBySeverity(): Record<AuditSeverity, number> {
  return { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 };
}

/** One entry in `.audits/closed.json` — written whenever a finding reaches a terminal state. */
export interface ClosureRecord {
  fingerprint: string;
  finding_id: string;
  closed_at: string;
  closing_pr: string | null;
  status: AuditStatus;
}

/** Shape of `.audits/closed.json`. */
export interface ClosedIndex {
  closures: ClosureRecord[];
}

// ---------------------------------------------------------------------------
// Audit-fix tag — the `[audit-fix:<id>]` brief prefix that couples /audit-fix
// dispatch to pipeline close-out. The parser moved into @wahq/orchestrator-core
// (the extracted queue source `sources/discord.ts` decorates completion
// messages with the finding id). Re-exported here so existing app import sites
// keep resolving from `audit/types`.
// ---------------------------------------------------------------------------

export {
  AUDIT_ID_PREFIX,
  AUDIT_FIX_GOAL_RE,
  extractAuditFindingId,
} from '@wahq/orchestrator-core/utils/audit-finding';
