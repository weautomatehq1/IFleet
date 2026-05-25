-- Audit findings table — shared source of truth between Mac dev and VPS.
-- Findings are never deleted; status moves open → fixing → closed.
-- Run against IFLEET_KG_DATABASE_URL (same Supabase project as the knowledge graph).

CREATE TABLE IF NOT EXISTS audit_findings (
  id            TEXT        PRIMARY KEY,
  repo          TEXT        NOT NULL,
  severity      TEXT        NOT NULL CHECK (severity IN ('CRITICAL', 'IMPORTANT', 'COSMETIC')),
  category      TEXT        NOT NULL DEFAULT 'logic',
  title         TEXT        NOT NULL,
  detail        TEXT        NOT NULL DEFAULT '',
  file_globs    TEXT[]      NOT NULL DEFAULT '{}',
  fix_sketch    TEXT        NOT NULL DEFAULT '',
  parallel_safe BOOLEAN     NOT NULL DEFAULT true,
  fingerprint   TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'fixing', 'verifying', 'reopened', 'closed')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  closing_pr    TEXT,
  scan_id       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_findings_repo_status   ON audit_findings (repo, status);
CREATE INDEX IF NOT EXISTS audit_findings_fingerprint   ON audit_findings (fingerprint);
CREATE INDEX IF NOT EXISTS audit_findings_sev_status    ON audit_findings (severity, status);
CREATE INDEX IF NOT EXISTS audit_findings_opened_at     ON audit_findings (opened_at DESC);

-- Active findings dedup: same fingerprint can't have two non-closed rows in
-- the same repo. Allows re-opening (insert) once the previous row is closed
-- so regressions get a new id but share fingerprint history.
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_fp_repo_active
  ON audit_findings (fingerprint, repo) WHERE status != 'closed';

CREATE OR REPLACE FUNCTION _audit_findings_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS audit_findings_updated_at ON audit_findings;
CREATE TRIGGER audit_findings_updated_at
  BEFORE UPDATE ON audit_findings
  FOR EACH ROW EXECUTE FUNCTION _audit_findings_set_updated_at();
