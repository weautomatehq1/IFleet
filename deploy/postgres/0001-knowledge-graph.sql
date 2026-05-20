-- M3.W1 — Knowledge graph schema (cross-repo code graph + semantic fallback)
--
-- Decided: ADR-0003 (tree-sitter symbolic layer + pgvector semantic fallback).
-- Spec:    docs/elevation/upgrades/03-knowledge-graph.md.
-- Target:  Supabase project ifleet-kg (pgvector pre-enabled).
--
-- This migration is idempotent — safe to re-run. The indexer uses a single
-- migration file at M3.W1; later weeks add 0002-*.sql etc.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- code_nodes — one row per symbol (file, class, function, type, const, enum).
-- Embeddings are stored as vector(1536) so either Voyage code-3 (1024,
-- left-padded) or OpenAI text-embedding-3-small (1536 native) fits without
-- a follow-up migration. The embedding column is NULL until embed.ts runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_nodes (
  id          BIGSERIAL   PRIMARY KEY,
  repo_id     TEXT        NOT NULL,
  path        TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  start_line  INT,
  end_line    INT,
  sha         TEXT        NOT NULL,
  signature   TEXT,
  docstring   TEXT,
  embedding   vector(1536),
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT  code_nodes_kind_chk CHECK (kind IN ('file','class','function','type','const','enum','interface','method'))
);

-- Unique on (repo_id, path, name, kind) so upserts have a single conflict target.
-- For file-kind nodes name === path; the constraint still works because (path,name,kind)
-- is unique per file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_code_nodes_identity
  ON code_nodes (repo_id, path, name, kind);

CREATE INDEX IF NOT EXISTS idx_code_nodes_repo_path
  ON code_nodes (repo_id, path);

CREATE INDEX IF NOT EXISTS idx_code_nodes_name
  ON code_nodes (name);

-- HNSW index for cosine similarity. Created CONCURRENTLY is not supported
-- inside a single migration with multiple statements on every Postgres setup,
-- so the build is in-transaction. Acceptable at M3.W1 scale; revisit if cold-
-- start indexing of a 200k-node repo gets slow.
CREATE INDEX IF NOT EXISTS idx_code_nodes_embedding
  ON code_nodes USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- code_edges — directed graph of relationships between code_nodes.
-- ON DELETE CASCADE because deleting a node removes its edges (re-indexing
-- a file deletes its prior nodes; we want the matching edges gone too).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_edges (
  src_id BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  dst_id BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  kind   TEXT   NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind),
  CONSTRAINT code_edges_kind_chk CHECK (kind IN ('calls','imports','extends','implements','uses_type','contains'))
);

CREATE INDEX IF NOT EXISTS idx_code_edges_dst
  ON code_edges (dst_id, kind);

-- ---------------------------------------------------------------------------
-- cross_repo_links — candidates flagged by reconciliation (M3.W4). Human
-- confirms via Discord button before they're trusted in queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cross_repo_links (
  id              BIGSERIAL   PRIMARY KEY,
  src_node_id     BIGINT      NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  dst_node_id     BIGINT      NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  link_kind       TEXT        NOT NULL,
  confidence      REAL        NOT NULL,
  human_confirmed BOOLEAN     NOT NULL DEFAULT FALSE,
  confirmed_by    TEXT,
  confirmed_at    TIMESTAMPTZ,
  proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cross_repo_links_kind_chk CHECK (link_kind IN ('same_entity','api_consumer','shared_schema')),
  CONSTRAINT cross_repo_links_confidence_chk CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_cross_repo_links_unconfirmed
  ON cross_repo_links (human_confirmed, confidence DESC)
  WHERE human_confirmed = FALSE;

-- ---------------------------------------------------------------------------
-- indexer_errors — per-file parse failures. Skipped files land here so the
-- indexer is non-blocking but we can audit coverage drift.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_errors (
  id            BIGSERIAL   PRIMARY KEY,
  repo_id       TEXT        NOT NULL,
  path          TEXT        NOT NULL,
  sha           TEXT        NOT NULL,
  stage         TEXT        NOT NULL,
  error_message TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_errors_stage_chk CHECK (stage IN ('parse','upsert','embed','io'))
);

CREATE INDEX IF NOT EXISTS idx_indexer_errors_recent
  ON indexer_errors (repo_id, occurred_at DESC);
