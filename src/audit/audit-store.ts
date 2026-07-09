// Supabase-backed store for audit findings.
// Uses the same IFLEET_KG_DATABASE_URL / pg pool as the knowledge graph.
// All functions are best-effort: they throw on DB error so callers can
// catch and fall back to the local file.

import { getKgPool } from '../agents/indexer/pg-client.js';
import {
  emptyBySeverity,
  isActiveAuditStatus,
  TERMINAL_AUDIT_STATUSES,
  type AuditFinding,
  type AuditIndex,
  type AuditStatus,
} from './types.js';

// TERMINAL_AUDIT_STATUSES is passed as a text[] parameter ($N) rather than
// interpolated into SQL — eliminates the structural injection risk even if a
// future status value ever contained a quote or special character.

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
 * Upsert findings into Supabase.
 *
 * Two dedup layers:
 *
 *  1. `WHERE NOT EXISTS` guards against a *different* finding id sharing the
 *     same fingerprint in the same repo while still active (not in a terminal
 *     state). This is the cross-scan dedup — if `/audit-scan` synthesises a
 *     new id for a code pattern that's already being tracked, we skip the
 *     insert so the existing row keeps its history.
 *  2. `ON CONFLICT (id) DO UPDATE` upserts when the *same* id is rewritten by
 *     a re-scan (detail/severity may have drifted). The update is conditional
 *     on the existing row not being terminal — once a finding is closed,
 *     fixed, or marked stale, its history is frozen.
 *
 * The previous code used `ON CONFLICT (id) DO NOTHING`, which silently
 * dropped updates to existing rows (AUDIT-IFleet-6757c552). The previous
 * `WHERE NOT EXISTS` predicate used `status != 'closed'`, so `fixed`/`stale`
 * rows still allowed regression inserts of the same fingerprint
 * (AUDIT-IFleet-e9f751ac).
 *
 * The atomicity gap between the `WHERE NOT EXISTS` subquery and the INSERT
 * is closed by the partial unique index `audit_findings_fp_repo_active`,
 * which (after migration 0003) covers `(fingerprint, repo)` with
 * `WHERE status NOT IN ('closed','fixed','stale')`. Concurrent INSERTs that
 * race past the subquery hit the index constraint and surface as an error
 * instead of silently duplicating.
 */
export async function dbUpsertFindings(findings: AuditFinding[], repo: string): Promise<void> {
  if (findings.length === 0) return;
  const repoKey = normaliseAuditRepo(repo);
  const pool = getKgPool();
  const client = await pool.connect();
  // SQL literal — TERMINAL_SQL_LIST is built from static enum values, never
  // user input. Same list in WHERE NOT EXISTS and ON CONFLICT WHERE clauses
  // so the two dedup layers can't disagree.
  const sql = `INSERT INTO audit_findings
       (id, repo, severity, category, title, detail, file_globs, fix_sketch,
        parallel_safe, fingerprint, status, opened_at, closed_at, closing_pr)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_findings
       WHERE fingerprint = $10 AND repo = $2
         AND NOT (status = ANY($15))
         AND id != $1
     )
     ON CONFLICT (id) DO UPDATE SET
       severity      = EXCLUDED.severity,
       category      = EXCLUDED.category,
       title         = EXCLUDED.title,
       detail        = EXCLUDED.detail,
       file_globs    = EXCLUDED.file_globs,
       fix_sketch    = EXCLUDED.fix_sketch,
       parallel_safe = EXCLUDED.parallel_safe,
       fingerprint   = EXCLUDED.fingerprint
     WHERE NOT (audit_findings.status = ANY($15))`;
  try {
    await client.query('BEGIN');
    for (const f of findings) {
      // pg natively serializes a JS string[] → Postgres TEXT[] for
      // file_globs. This is safe for ordinary glob patterns. Patterns that
      // embed `{` `}` `,` `"` or `\` would need explicit array-literal
      // formatting via pg-format; we don't use any of those in practice,
      // but a regression test would be needed before relying on it.
      const openedAt = f.opened_at?.trim() ? f.opened_at : new Date().toISOString();
      await client.query(sql, [
        f.id, repoKey, f.severity, f.category, f.title, f.detail,
        f.file_globs, f.fix_sketch, f.parallel_safe, f.fingerprint,
        f.status, openedAt, f.closed_at, f.closing_pr,
        TERMINAL_AUDIT_STATUSES,
      ]);
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
 * Returns true when a row was actually updated, false when the id was not found
 * — or, when `refuseFromTerminal` is set, when the existing row is already in a
 * terminal state and the SQL guard blocked the update.
 *
 * `refuseFromTerminal` is the opt-in safety knob for the verifier+doctor loop,
 * which mirrors a `fixing` → `verifying` flip into Supabase. Without the guard
 * a terminal row (closed / fixed / stale) would silently regress to
 * `verifying`. Existing call sites — markFindingClosed's mirror to `closed`,
 * the Discord `/audit fixing` handler, and the explicit reopen-to-`open` path
 * — keep the previous unconditional behaviour by leaving the flag unset.
 */
export async function dbUpdateFindingStatus(
  id: string,
  status: AuditStatus,
  extra: { closing_pr?: string; closed_at?: string; refuseFromTerminal?: boolean } = {},
): Promise<boolean> {
  const pool = getKgPool();
  const terminalGuard = extra.refuseFromTerminal
    ? ` AND NOT (status = ANY($5))`
    : '';
  const params: Array<string | readonly string[] | null> = [
    id, status, extra.closed_at ?? null, extra.closing_pr ?? null,
  ];
  if (extra.refuseFromTerminal) params.push(TERMINAL_AUDIT_STATUSES);
  const result = await pool.query(
    `UPDATE audit_findings
     SET status = $2, closed_at = COALESCE($3, closed_at), closing_pr = COALESCE($4, closing_pr)
     WHERE id = $1${terminalGuard}`,
    params,
  );
  if (result.rowCount === 0) {
    console.warn(`[audit-store] dbUpdateFindingStatus: finding ${id} not found — no rows updated`);
    return false;
  }
  return true;
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
  } catch (err) {
    console.warn(`[audit-store] dbReadIndex: DB unreachable for repo ${repoKey}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
  if (findings.length === 0) return null;
  // `active` mirrors `recomputeCounts()` in audit-runner: only `open` or
  // `reopened` findings count toward the rollup. Keeping the two filters
  // lockstep is the invariant that prevents local index.json and Supabase
  // rollups from diverging (AUDIT-IFleet-ab40871b).
  const active = findings.filter((f) => isActiveAuditStatus(f.status));
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
