-- M5 — goal_proposals table (Proposer agent's HITL persistence surface).
--
-- Spec:    docs/elevation/upgrades/06-goal-driven.md §"Data model".
-- Target:  Supabase project ifleet-kg (same as M3 knowledge graph + M4 audits).
-- Migration runner: scripts/kg/migrate.ts (pnpm graph:migrate). Idempotent.
--
-- Rollback (manual, not automated — IFleet is internal infra with no prod data
-- to preserve):
--   DROP INDEX IF EXISTS idx_proposals_embedding;
--   DROP INDEX IF EXISTS idx_proposals_repo_proposed;
--   DROP TABLE IF EXISTS goal_proposals;
--
-- Multi-tenant note: IFleet is single-tenant (one Sebastian, one fleet). RLS
-- is intentionally not applied — the database is reachable only from the
-- daemon and `pnpm graph:migrate` running on a trusted host. If the deploy
-- model ever changes (multi-org Factory tenants), add RLS keyed on `repo_id`.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- goal_proposals — one row per candidate posted to #ifleet-proposals.
-- decision starts NULL; the Discord button handlers (T5 approval-gate
-- extension) write 'approved' | 'rejected' | 'deferred'. 'expired' is set by
-- a future GC sweep when a proposal is older than the lookback window and
-- never decided.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goal_proposals (
  id                    TEXT        PRIMARY KEY,
  repo_id               TEXT        NOT NULL,
  proposed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source                TEXT        NOT NULL
                                    CHECK (source IN ('sprint_gap','learnings','drift','error_log','coherence')),
  title                 TEXT        NOT NULL,
  rationale             TEXT        NOT NULL,
  estimated_value       REAL,
  estimated_difficulty  REAL,
  embedding             vector(1536),
  decision              TEXT        CHECK (decision IS NULL OR decision IN ('approved','rejected','deferred','expired')),
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  resulting_task_id     TEXT,
  resulting_pr_url      TEXT,
  resulting_pr_outcome  TEXT        CHECK (resulting_pr_outcome IS NULL OR resulting_pr_outcome IN ('merged','rejected','closed_unmerged')),
  CONSTRAINT goal_proposals_value_chk
    CHECK (estimated_value IS NULL OR (estimated_value >= 0 AND estimated_value <= 1)),
  CONSTRAINT goal_proposals_difficulty_chk
    CHECK (estimated_difficulty IS NULL OR (estimated_difficulty >= 0 AND estimated_difficulty <= 1))
);

-- Listing/dedup-history query path: (repo_id, proposed_at DESC).
CREATE INDEX IF NOT EXISTS idx_proposals_repo_proposed
  ON goal_proposals (repo_id, proposed_at DESC);

-- HNSW index for cosine similarity — used by T4 dedupe.ts. Build is in-
-- transaction; M3.W1 made the same trade for code_nodes (see 0001 comment).
CREATE INDEX IF NOT EXISTS idx_proposals_embedding
  ON goal_proposals USING hnsw (embedding vector_cosine_ops);
