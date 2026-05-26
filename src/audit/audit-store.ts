// Supabase-backed store for audit findings.
// Uses the same IFLEET_KG_DATABASE_URL / pg pool as the knowledge graph.
// All functions are best-effort: they throw on DB error so callers can
// catch and fall back to the local file.

import { getKgPool } from '../agents/indexer/pg-client.js';
import {
  emptyBySeverity,
  type AuditFinding,
  type AuditIndex,
  type AuditStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Repo-name normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical form of `audit_findings.repo` — the basename of a possibly-qualified
 * GitHub slug (`weautomatehq1/IFleet` → `IFleet`). Applied at every read and
 * write boundary so the bot can't end up writing under one shape and reading
 * under another.
 *
 * Historically this was inlined in three places (`sync-audit-findings.ts`,
 * `interaction-create.ts`, `audit-runner.ts` via the `.audits/index.json`
 * `repo` field) and one of them silently used the org-qualified form, so DB
 * reads always returned empty. Centralising it here makes the invariant
 * checkable from one location.
 */
export function normaliseAuditRepo(repo: string): string {
  const slashIdx = repo.lastIndexOf('/');
  return slashIdx === -1 ? repo : repo.slice(slashIdx + 1);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Upsert findings into Supabase. Skips any finding whose fingerprint already
 * exists in the DB with a non-closed status (dedup across scans). If the same
 * fingerprint exists only as closed, inserts as a new open finding (regression).
 */
export async function dbUpsertFindings(findings: AuditFinding[], repo: string): Promise<void> {
  if (findings.length === 0) return;
  const repoKey = normaliseAuditRepo(repo);
  const pool = getKgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of findings) {
      const openedAt = f.opened_at || new Date().toISOString();
      await client.query(
        `INSERT INTO audit_findings
           (id, repo, severity, category, title, detail, file_globs, fix_sketch,
            parallel_safe, fingerprint, status, opened_at, closed_at, closing_pr)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_findings
           WHERE fingerprint = $10 AND repo = $2 AND status != 'closed'
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          f.id, repoKey, f.severity, f.category, f.title, f.detail,
          f.file_globs, f.fix_sketch, f.parallel_safe, f.fingerprint,
          f.status, openedAt, f.closed_at, f.closing_pr,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update the status (and optionally closed_at / closing_pr) of a finding.
 * No-ops if the finding doesn't exist.
 */
export async function dbUpdateFindingStatus(
  id: string,
  status: AuditStatus,
  extra: { closing_pr?: string; closed_at?: string } = {},
): Promise<void> {
  const pool = getKgPool();
  await pool.query(
    `UPDATE audit_findings
     SET status = $2, closed_at = COALESCE($3, closed_at), closing_pr = COALESCE($4, closing_pr)
     WHERE id = $1`,
    [id, status, extra.closed_at ?? null, extra.closing_pr ?? null],
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read all findings for a repo from Supabase, newest first. */
export async function dbReadFindings(repo: string): Promise<AuditFinding[]> {
  const pool = getKgPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT id, severity, category, title, detail, file_globs, fix_sketch,
            parallel_safe, fingerprint, status, opened_at, closed_at, closing_pr
     FROM audit_findings
     WHERE repo = $1
     ORDER BY opened_at DESC`,
    [normaliseAuditRepo(repo)],
  );
  return rows.map(rowToFinding);
}

/**
 * Build an AuditIndex from Supabase. Returns null when the DB is unreachable
 * OR no findings exist for the repo (zero rows). Callers must treat null as
 * "Supabase has no data for this repo yet — fall back to local file" rather
 * than as a hard error; the local index.json on Mac is the source of truth
 * until `pnpm audit:sync` lands findings into Supabase.
 */
export async function dbReadIndex(repo: string): Promise<AuditIndex | null> {
  const repoKey = normaliseAuditRepo(repo);
  let findings: AuditFinding[];
  try {
    findings = await dbReadFindings(repoKey);
  } catch {
    return null;
  }
  if (findings.length === 0) return null;
  // `active` mirrors `openFindings()` in audit-runner: any non-closed status counts.
  const active = findings.filter((f) => f.status !== 'closed');
  const by_severity = emptyBySeverity();
  for (const f of active) by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
  return {
    repo: repoKey,
    last_updated: new Date().toISOString(),
    open_findings: active.length,
    by_severity,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  severity: string;
  category: string;
  title: string;
  detail: string;
  file_globs: string[];
  fix_sketch: string;
  parallel_safe: boolean;
  fingerprint: string;
  status: string;
  opened_at: Date;
  closed_at: Date | null;
  closing_pr: string | null;
}

function rowToFinding(row: DbRow): AuditFinding {
  return {
    id: row.id,
    severity: row.severity as AuditFinding['severity'],
    category: row.category,
    title: row.title,
    detail: row.detail,
    file_globs: row.file_globs,
    fix_sketch: row.fix_sketch,
    parallel_safe: row.parallel_safe,
    fingerprint: row.fingerprint,
    status: row.status as AuditStatus,
    opened_at: row.opened_at.toISOString(),
    closed_at: row.closed_at ? row.closed_at.toISOString() : null,
    closing_pr: row.closing_pr,
  };
}
