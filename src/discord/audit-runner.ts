// Audit-fix logic for the Discord `/audit-fix` command.
//
// Reads/writes `.audits/index.json` (the rollup written by `/audit-scan`),
// synthesizes task briefs from findings, formats the Discord list output, and
// flips finding status (`open` → `fixing` → `closed`) as work moves through
// the pipeline.
//
// This module is intentionally free of discord.js and ControlCommand types:
// the interaction handler builds commands, the pipeline runner imports only
// the close-out helpers. Keeping it a pure fs/format utility lets both the
// Discord and pipeline packages depend on it without a runtime coupling.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AuditSeverity = 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';
export type AuditStatus = 'open' | 'fixing' | 'verifying' | 'reopened' | 'closed' | 'fixed' | 'stale';

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

/** Severity ordering for list grouping and auto-mode dispatch (worst first). */
const SEVERITY_ORDER: readonly AuditSeverity[] = ['CRITICAL', 'IMPORTANT', 'COSMETIC'];

const AUDIT_STATUSES: readonly AuditStatus[] = [
  'open',
  'fixing',
  'verifying',
  'reopened',
  'closed',
  'fixed',
  'stale',
];

/**
 * Regex that recognises an audit-fix task. `/audit-fix` prefixes every
 * synthesized brief with `[audit-fix:<finding id>]`; the pipeline runner uses
 * this to know a completed task should close a finding in `index.json`.
 */
export const AUDIT_FIX_GOAL_RE = /\[audit-fix:(AUDIT-[^\]]+)\]/;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Repo root that holds `.audits/`. The Discord bot and the pipeline both run
 * inside the IFleet daemon process, which sets `IFLEET_REPO_ROOT`; falling
 * back to `process.cwd()` matches `src/orchestrator/daemon.ts`. Both callers
 * therefore resolve the same path, so `/audit-fix` and the pipeline close-out
 * touch the same file.
 */
export function auditRepoRoot(): string {
  return process.env['IFLEET_REPO_ROOT'] ?? process.cwd();
}

/** Absolute path to `.audits/index.json`, given a repo root (or the default). */
export function resolveAuditIndexPath(repoRoot?: string): string {
  return join(repoRoot ?? auditRepoRoot(), '.audits', 'index.json');
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read and normalise `.audits/index.json`. Returns `null` when the file is
 * missing or unparseable — callers treat that as "no findings yet".
 */
export function readAuditIndex(indexPath: string): AuditIndex | null {
  if (!existsSync(indexPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj['findings'])) return null;

  const findings = obj['findings']
    .map(coerceFinding)
    .filter((f): f is AuditFinding => f !== null);
  const index: AuditIndex = {
    repo: typeof obj['repo'] === 'string' ? obj['repo'] : 'repo',
    last_updated: typeof obj['last_updated'] === 'string' ? obj['last_updated'] : '',
    open_findings: 0,
    by_severity: {},
    findings,
  };
  recomputeCounts(index);
  return index;
}

/** Atomically write `index.json` (tmp file + rename), refreshing counts. */
export function writeAuditIndex(indexPath: string, index: AuditIndex): void {
  recomputeCounts(index);
  index.last_updated = new Date().toISOString();
  const tmp = join(dirname(indexPath), `.index.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  renameSync(tmp, indexPath);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Findings still actionable, worst severity first. `reopened` findings come
 * from /audit-scan flipping a previously-closed item back when its fingerprint
 * resurfaces; they're as dispatch-eligible as fresh `open` items and the
 * caller path (formatFindingsList, /audit-fix auto, interaction-create's
 * fix-one guard) must treat them identically.
 */
export function openFindings(index: AuditIndex): AuditFinding[] {
  return index.findings
    .filter((f) => f.status === 'open' || f.status === 'reopened')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** Extract the finding id from an audit-fix task goal, or `null` if absent. */
export function extractAuditFindingId(goal: string): string | null {
  return goal.match(AUDIT_FIX_GOAL_RE)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Brief synthesis
// ---------------------------------------------------------------------------

/** The `[audit-fix:<id>]` tag that marks a goal as an audit-fix task. */
export function auditFixGoalTag(findingId: string): string {
  return `[audit-fix:${findingId}]`;
}

/** Build the `sprint_goal` brief for a single finding. */
export function synthesizeAuditBrief(finding: AuditFinding): string {
  const globs = finding.file_globs.length > 0 ? finding.file_globs.join(', ') : '(not specified)';
  return [
    `${auditFixGoalTag(finding.id)} Fix: ${finding.title}`,
    ``,
    finding.detail,
    ``,
    `Fix approach: ${finding.fix_sketch}`,
    ``,
    `Files likely affected: ${globs}`,
    ``,
    `When done, open a PR. Include "${finding.id}" in the PR title or body.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// List formatting
// ---------------------------------------------------------------------------

/** Discord-message limit; replies stay well under the 2000-char hard cap. */
const LIST_MAX_CHARS = 1900;

const LIST_FOOTER = 'Run `/audit-fix <id>` to fix one · `/audit-fix auto` to fix all';

/** Format the open findings as a grouped Discord message. */
export function formatFindingsList(index: AuditIndex): string {
  const open = openFindings(index);
  const repoLabel = index.repo || 'repo';
  if (open.length === 0) {
    return `**Open audit findings** — ${repoLabel} (0 open)\n\nNo open findings. Run \`/audit-scan\` to look for more.`;
  }

  const header = `**Open audit findings** — ${repoLabel} (${open.length} open)`;
  const blocks: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const group = open.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const lines = group.map((f) => `• \`${f.id}\` — ${f.title}`);
    blocks.push(`**${sev} (${group.length})**\n${lines.join('\n')}`);
  }

  const full = `${[header, ...blocks].join('\n\n')}\n\n${LIST_FOOTER}`;
  if (full.length <= LIST_MAX_CHARS) return full;

  // Too long for one message — keep whole lines until the budget runs out.
  const lines = [header, '', ...blocks.join('\n\n').split('\n')];
  const kept: string[] = [];
  let used = 0;
  const budget = LIST_MAX_CHARS - LIST_FOOTER.length - 60;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.join('\n')}\n\n… more findings not shown — fix some first or narrow with \`/audit-fix <id>\`\n\n${LIST_FOOTER}`;
}

// ---------------------------------------------------------------------------
// Status mutation
// ---------------------------------------------------------------------------

/**
 * Set `status` on the given findings (skipping any already `closed`). Returns
 * the number of findings actually updated. No-op when the index is missing.
 */
export function setFindingsStatus(
  indexPath: string,
  ids: readonly string[],
  status: AuditStatus,
): number {
  const index = readAuditIndex(indexPath);
  if (!index) return 0;
  const wanted = new Set(ids);
  let updated = 0;
  for (const finding of index.findings) {
    if (wanted.has(finding.id) && finding.status !== 'closed' && finding.status !== status) {
      finding.status = status;
      updated++;
    }
  }
  if (updated > 0) writeAuditIndex(indexPath, index);
  return updated;
}

/** Mark findings `fixing` ahead of dispatching them to the control plane. */
export function markFindingsFixing(indexPath: string, ids: readonly string[]): number {
  return setFindingsStatus(indexPath, ids, 'fixing');
}

/**
 * Mark a finding `closed` and record the PR that closed it. Returns `false`
 * (and logs a warning) when the index or the finding is missing — never
 * throws, so a pipeline close-out can call this without a guard.
 *
 * `prUrl` may be `null` for non-PR closures (e.g. the editor/architect short
 * -circuited with NO_CHANGES_NEEDED / ALREADY_RESOLVED). The previous form
 * stored the literal string `'already-resolved'` into `closing_pr`, which
 * corrupted the rollup downstream.
 */
export function markFindingClosed(
  indexPath: string,
  findingId: string,
  prUrl: string | null,
): boolean {
  const index = readAuditIndex(indexPath);
  if (!index) {
    console.warn(`[audit-fix] cannot close ${findingId}: no audit index at ${indexPath}`);
    return false;
  }
  const finding = index.findings.find((f) => f.id === findingId);
  if (!finding) {
    console.warn(`[audit-fix] cannot close ${findingId}: not found in ${indexPath}`);
    return false;
  }
  finding.status = 'closed';
  finding.closing_pr = prUrl;
  finding.closed_at = new Date().toISOString();
  writeAuditIndex(indexPath, index);
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** `open_findings` / `by_severity` count only `open` and `reopened` findings — matching `openFindings()`. */
function recomputeCounts(index: AuditIndex): void {
  const active = index.findings.filter((f) => f.status === 'open' || f.status === 'reopened');
  index.open_findings = active.length;
  const by: Record<string, number> = { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 };
  for (const f of active) by[f.severity] = (by[f.severity] ?? 0) + 1;
  index.by_severity = by;
}

function isAuditStatus(v: unknown): v is AuditStatus {
  return typeof v === 'string' && (AUDIT_STATUSES as readonly string[]).includes(v);
}

function coerceFinding(raw: unknown): AuditFinding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string') return null;
  const severity = o['severity'];
  return {
    id: o['id'],
    severity:
      severity === 'CRITICAL' || severity === 'IMPORTANT' || severity === 'COSMETIC'
        ? severity
        : 'IMPORTANT',
    category: typeof o['category'] === 'string' ? o['category'] : 'logic',
    title: typeof o['title'] === 'string' ? o['title'] : o['id'],
    detail: typeof o['detail'] === 'string' ? o['detail'] : '',
    file_globs: Array.isArray(o['file_globs'])
      ? o['file_globs'].filter((x): x is string => typeof x === 'string')
      : [],
    fix_sketch: typeof o['fix_sketch'] === 'string' ? o['fix_sketch'] : '',
    parallel_safe: o['parallel_safe'] !== false,
    fingerprint: typeof o['fingerprint'] === 'string' ? o['fingerprint'] : '',
    status: isAuditStatus(o['status']) ? o['status'] : 'open',
    opened_at: typeof o['opened_at'] === 'string' ? o['opened_at'] : '',
    closed_at: typeof o['closed_at'] === 'string' ? o['closed_at'] : null,
    closing_pr: typeof o['closing_pr'] === 'string' ? o['closing_pr'] : null,
  };
}
