// Canonical audit-finding types. Both the Discord runner (`src/discord/audit-runner.ts`)
// and the Supabase store (`src/audit/audit-store.ts`) import from here so the two
// surfaces can't drift on status enums or rollup shape.

export type AuditSeverity = 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';

export type AuditStatus =
  | 'open'
  | 'fixing'
  | 'verifying'
  | 'reopened'
  | 'closed';

export const AUDIT_STATUSES: readonly AuditStatus[] = [
  'open',
  'fixing',
  'verifying',
  'reopened',
  'closed',
];

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
