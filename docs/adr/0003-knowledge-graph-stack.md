# ADR-0003 — Knowledge graph stack: tree-sitter + Postgres + pgvector

**Status:** Accepted (2026-05-19)
**Decider:** Sebastian Puig
**Affects:** M3 (cross-repo knowledge graph) onward

## Context

IFleet's architect currently builds context via grep + brief library lookups. Token cost scales linearly with sprint count and the architect cannot answer "what calls this function across all 17 repos." The published literature is unambiguous:

- **RepoGraph (ICLR 2025):** plug-in code graph + `search_repograph()` tool delivers +32.8% average relative improvement across SWE-Bench agent frameworks.
- **Codebase-Memory (2026):** tree-sitter + MCP KG hits 83% answer quality at **10× fewer tokens and 2.1× fewer tool calls** vs. brute-force file exploration.
- **Sourcegraph Cody RSG:** moved explicitly away from pure embeddings toward hybrid symbolic+semantic.

Pure embedding similarity is a known-loser strategy in this domain (string-match on chunks misses both structural relationships and semantically-distant-but-relevant code).

## Decision

**Two-layer stack: tree-sitter (symbolic) + Postgres + pgvector (semantic fallback).**

- **Symbolic layer:** tree-sitter parses each file → `code_nodes` (file, class, function, type, const) + `code_edges` (calls, imports, extends, implements, uses_type). Hard lookups (Find Definitions, Find References, "what calls X") via SQL.
- **Semantic layer:** embed function signatures + docstrings (Voyager-style description embeddings). Fallback for "find me code that does X" queries the symbolic layer can't answer.
- **Cross-repo links:** `cross_repo_links` table maintained by daily reconciliation job (type-name match → human confirm).

## Why Postgres + pgvector (not SQLite)

- IFleet uses SQLite today for task state. Postgres is **net new infra** for IFleet but already present at WeAutomateHQ (n8n + Supabase). Acceptable cost.
- pgvector is the standard sidecar for embedding storage when the rest of the data is relational. One extension. No separate vector DB.
- SQLite alternatives: sqlite-vec works for prototyping but lacks the HNSW index quality and concurrent-write story.

## Alternatives considered

1. **Sourcegraph self-hosted.** Rejected — operational burden for <50 repos. Overkill.
2. **Pure embeddings (no symbolic layer).** Rejected — known loser per Section B of the elevation research.
3. **LSP-only (typescript-language-server, pyright).** Rejected — no semantic fallback for "find code that does X" queries.
4. **Weaviate / Qdrant / Pinecone.** Rejected — extra service, separate auth, separate backup story. pgvector is sufficient.
5. **SQLite + sqlite-vec.** Rejected — works for <10k nodes; IFleet's 17 repos will hit ~50-200k nodes. HNSW in pgvector is the better long-term bet.

## Data model

See `docs/elevation/upgrades/03-knowledge-graph.md` for full schema. Key tables:

```sql
code_nodes (id, repo_id, path, kind, name, start_line, end_line, sha, signature, docstring, embedding vector(1536))
code_edges (src_id, dst_id, kind)
cross_repo_links (id, src_node_id, dst_node_id, link_kind, confidence, human_confirmed)
```

HNSW index on `code_nodes.embedding`. B-tree on `(repo_id, path)`.

## Embedding choice

- **Provider:** Anthropic doesn't offer embeddings; use Voyage AI `voyage-code-3` (best for code per their benchmarks) OR OpenAI `text-embedding-3-small`. Decide in M3.W2.
- **Dimensions:** 1024 (Voyage) or 1536 (OpenAI). Schema uses 1536 to accommodate either; smaller is fine with padding or migration.

## Chunking strategy

Per RepoGraph: **chunk by symbol, not by line.** A function is one node (full body in `signature` for short ones, externalized for long ones). A class is one node. A type alias is one node. Imports are edges, not nodes.

## Refresh strategy

- **Trigger:** GitHub webhook on push to default branch
- **Scope:** Diff changed files only (not full re-index)
- **Latency:** <30s from merge to graph updated
- **Cold start:** First-time repo registration runs full index (5-15 min for 50k LOC repo)

## Consequences

**Positive:**
- Architect token cost -30-50% (Codebase-Memory benchmark was 10×, expect less in practice)
- Cross-repo coherence (M6) becomes feasible — no graph, no detector
- PR rejection learning (M4 / Upgrade 5) reuses pgvector

**Negative:**
- New infra: Postgres on Hostinger VPS (or use Supabase)
- New embedding API cost (Voyage: $0.12/1M tokens for code-3)
- Backup story: pgdump cron in `deploy/`

## Open questions for M3.W1

- ~~Postgres on Hostinger VPS or Supabase?~~ **DECIDED → Supabase** (project: `ifleet-kg`, region: `us-east-1` N. Virginia, host: `db.exswghbtgtdykklcsdxq.supabase.co`). Provisioned 2026-05-19. pgvector enabled and smoke-tested. **VPS note:** direct connection (port 5432) is IPv4-incompatible; indexer on VPS must use Session Pooler (port 6543) — swap URL at M3.W1 wiring time.
- Voyage AI vs. OpenAI embeddings? (Voyage code-3 has better benchmarks; OpenAI is simpler to integrate)
- Tree-sitter language coverage day-1: TS only, or TS + Python + Go simultaneously? (TS-only M3.W1, expand M3.W5)

## References

- [RepoGraph paper / ICLR 2025](https://arxiv.org/html/2410.14684v1)
- [Codebase-Memory: Tree-sitter KG for LLM Code Exploration](https://arxiv.org/abs/2603.27277)
- [How Cody understands your codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
- [pgvector](https://github.com/pgvector/pgvector)
- [Voyage AI voyage-code-3](https://docs.voyageai.com/docs/embeddings)
