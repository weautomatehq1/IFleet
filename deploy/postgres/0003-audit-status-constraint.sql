-- Extend audit_findings.status to accept the two terminal states added in code:
--   'fixed' — written by reconcileMergedPRs in scripts/audit-ritual.ts when a
--             merged PR's title or body referenced the finding id.
--   'stale' — written by manual cleanup of findings whose code is gone.
-- The previous CHECK constraint rejected both, so sync-audit-findings.ts crashed
-- on any batch that contained one (CRITICAL AUDIT-IFleet-20a84c50).
--
-- Forward-only: existing rows are all in {open, fixing, verifying, reopened,
-- closed}, every one of which is still accepted by the new constraint. The
-- DROP/ADD is required because Postgres has no in-place CHECK relaxation —
-- it's a constraint *replacement*, not a column rewrite, and rows are not
-- touched.
--
-- Closes:
--   AUDIT-IFleet-20a84c50 (CRITICAL — DB CHECK rejects 'fixed'/'stale')
--   AUDIT-IFleet-e914fede, 2895f175, 3c8f2809, 753a2e31, cc293b19, 413aedac,
--   AUDIT-IFleet-417247ec, 02284074 (sync filter siblings)

ALTER TABLE audit_findings
  DROP CONSTRAINT IF EXISTS audit_findings_status_check;

ALTER TABLE audit_findings
  ADD CONSTRAINT audit_findings_status_check
  CHECK (status IN ('open', 'fixing', 'verifying', 'reopened', 'closed', 'fixed', 'stale'));

-- The partial unique index used `status != 'closed'`, which (with the enum
-- extended) would still treat 'fixed' and 'stale' as "active" — blocking
-- re-scans from inserting a regression row with the same fingerprint. Replace
-- it with one that excludes every terminal status so the index matches the
-- new openFindings()/dbReadIndex semantics in audit-runner.ts/audit-store.ts.

DROP INDEX IF EXISTS audit_findings_fp_repo_active;
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_fp_repo_active
  ON audit_findings (fingerprint, repo)
  WHERE status NOT IN ('closed', 'fixed', 'stale');
