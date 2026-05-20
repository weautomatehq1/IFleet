# Upgrade 3 — Cross-repo knowledge graph

**Month:** M3 | **Depends on:** ADR-0003, M2 complete | **KPI:** Architect token cost per task -30-50%

## What it does

Per-repo symbol graph (tree-sitter → `code_nodes` + `code_edges` in Postgres) with embedding fallback (pgvector). Architect gains `query_code_graph(query, repo_id?, depth=2)` tool. Called **before** drafting a plan. Plan output footer cites the nodes used.

Cross-repo: `cross_repo_links` table flags candidates ("`User` in repo A == `UserRow` in repo B?"), human confirms via Discord button.

## Why it matters

- Architect currently re-derives context via grep every sprint → linear token cost growth.
- RepoGraph (ICLR 2025) shows +32.8% performance from graph-based retrieval across agent frameworks.
- Codebase-Memory shows 10× fewer tokens for equivalent answer quality.
- Foundation for: cross-repo coherence watcher (M6), PR rejection learning (M4), self-improving IFleet (deferred).

## Integration into IFleet

**New service:** `src/agents/indexer/` — listens for GitHub webhooks, parses changed files, upserts nodes/edges.

**New architect tool:** `query_code_graph(query, repo_id?, depth=2)` returns:
- ego-graph: matching nodes + neighbors up to `depth` hops
- semantic fallback: top-N by embedding similarity (when symbolic match returns <3 results)

**Files added in M3:**

```
src/agents/indexer/
├── index.ts                  # IndexerAgent — webhook handler, orchestrates parse+upsert
├── parser.ts                 # tree-sitter wrappers (TS, Python, Go)
├── upsert.ts                 # node + edge upsert with conflict resolution
├── embed.ts                  # Voyage/OpenAI embedding calls + batching
├── cross-repo.ts             # candidate generation for cross_repo_links
└── __tests__/

src/agents/architect/tools/
└── query_code_graph.ts       # the new architect tool

deploy/postgres/
└── 0001-knowledge-graph.sql  # schema migration
```

## Data model

```sql
-- Postgres (NOT SQLite — pgvector requirement)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE code_nodes (
  id BIGSERIAL PRIMARY KEY,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,                -- file | class | function | type | const | enum
  name TEXT NOT NULL,
  start_line INT, end_line INT,
  sha TEXT NOT NULL,                 -- commit at indexing time
  signature TEXT,                    -- function sig or class header
  docstring TEXT,
  embedding vector(1536),
  indexed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_code_nodes_embedding ON code_nodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_code_nodes_repo_path ON code_nodes(repo_id, path);
CREATE INDEX idx_code_nodes_name ON code_nodes(name);

CREATE TABLE code_edges (
  src_id BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  dst_id BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- calls | imports | extends | implements | uses_type
  PRIMARY KEY (src_id, dst_id, kind)
);

CREATE TABLE cross_repo_links (
  id BIGSERIAL PRIMARY KEY,
  src_node_id BIGINT NOT NULL REFERENCES code_nodes(id),
  dst_node_id BIGINT NOT NULL REFERENCES code_nodes(id),
  link_kind TEXT NOT NULL,           -- same_entity | api_consumer | shared_schema
  confidence REAL NOT NULL,          -- 0..1 from match algorithm
  human_confirmed BOOLEAN DEFAULT FALSE,
  confirmed_by TEXT, confirmed_at TIMESTAMPTZ
);
```

## Pipeline step

**IndexerAgent triggered by:**
1. Repo registration → full index (cold start)
2. GitHub push webhook on default branch → incremental (changed files only)
3. Nightly doctor cron → reconciliation (catches webhook drops)

**Architect call sequence (M3+):**
```typescript
// Before drafting plan
const context = await query_code_graph({
  query: brief.title + "\n" + brief.body,
  repo_id: task.repo_id,
  depth: 2
});
// context.nodes: ego-graph of relevant symbols
// context.cross_repo_candidates: matches in other repos (if cross-repo work)

// Plan output footer
plan.context_used = context.nodes.map(n => ({ path: n.path, name: n.name, lines: `${n.start_line}-${n.end_line}` }));
```

## Discord interface

| Command | Behavior |
|---|---|
| `/graph stats` | Per-repo: node count by kind, edge count, last index timestamp, embedding coverage % |
| `/graph search "<query>" [--repo X]` | Human debugging — returns top 10 nodes with previews |
| `/graph links --repo X` | Lists pending `cross_repo_links` with `[Confirm] [Reject]` buttons |

## Failure modes

| Failure | Handling |
|---|---|
| Tree-sitter parse error on a file | Skip + log to `indexer_errors` table, don't block |
| Embedding API rate limit | Local cache + exponential backoff; degrade to symbolic-only queries |
| Stale index after force-push | Invalidate by `(repo_id, branch, sha)`, lazy re-index on first query |
| Postgres unavailable | Architect falls back to existing grep-based context (current M0-M2 behavior); banner in trace |
| Embedding provider outage (Voyage / OpenAI) | Symbolic-only mode; alert in `#ifleet-ops` |

## Implementation order

| Week | Deliverable | Status |
|---|---|---|
| W1 | Postgres setup (Supabase decision per ADR-0003). Schema migration. tree-sitter for TypeScript only. Indexer triggered manually via `pnpm graph:index <repoId> <pathToCheckout>`. Voyage embedding pipeline scaffolded (best-effort, gracefully off when key missing). Architect `query_code_graph` tool **stub** behind `IFLEET_KG_ENABLED`. | **shipped — feat/m3-knowledge-graph-core** |
| W2 | pgvector live embeddings on every index pass. Architect `query_code_graph` real traversal (ego-graph + semantic fallback). | pending |
| W3 | GitHub webhook integration. Incremental updates. Architect uses graph for top 3 routine task types in production. | pending |
| W4 | Cross-repo link generation. Discord `/graph` commands. Human confirmation workflow. | pending |
| W5-6 | Python + Go tree-sitter parsers. Reconciliation cron. | pending |

## Embedding choice — decide M3.W2

| | Voyage code-3 | OpenAI text-embedding-3-small |
|---|---|---|
| Quality on code | Higher (purpose-built) | Lower but acceptable |
| Cost | $0.12/1M tokens | $0.02/1M tokens |
| Dimensions | 1024 | 1536 (or 512 with truncation) |
| Integration burden | New API key | Already have OpenAI key probably |
| **Recommendation** | **Use Voyage** | Fall back if Voyage unavailable |

## Verification (Definition of Done for M3)

- IFleet repo fully indexed (≥20k nodes, ≥80k edges).
- 5 historical sprints replayed with architect using `query_code_graph` — token cost drops measurably vs. baseline.
- `/graph search "verifier"` returns the right nodes in <500ms.
- At least 3 cross_repo_links confirmed by human.

## References

- [RepoGraph (ICLR 2025)](https://arxiv.org/html/2410.14684v1)
- [Codebase-Memory](https://arxiv.org/abs/2603.27277)
- [pgvector docs](https://github.com/pgvector/pgvector)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [Voyage AI embeddings](https://docs.voyageai.com/docs/embeddings)
