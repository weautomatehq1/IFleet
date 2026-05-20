# IndexerAgent — M3.W1 scaffold

> Cross-repo knowledge graph indexer. Builds `code_nodes` + `code_edges` in
> Postgres + pgvector. See ADR-0003 and `docs/elevation/upgrades/03-knowledge-graph.md`
> for the full spec.

## Scope of M3.W1

| Done in this PR | Deferred |
|---|---|
| TypeScript + TSX parser (tree-sitter) | Python + Go parsers (M3.W5) |
| Postgres schema (`deploy/postgres/0001-knowledge-graph.sql`) | GitHub webhook integration (M3.W3) |
| Node + edge upsert (transactional, idempotent) | Cross-repo link generation (M3.W4) |
| Voyage AI embedding pipeline (`voyage-code-3`) | Architect runtime integration (M3.W3) |
| CLI: `pnpm graph:index <repoId> <pathToCheckout>` | Discord `/graph` commands (M3.W4) |
| Architect tool stub (returns empty + log) | Reconciliation cron (M3.W5) |

## Architecture in 6 lines

```
files in   →   parser.ts     →   nodes + edges
                                       ↓
                                  upsert.ts (transactional)
                                       ↓
                                  Postgres (code_nodes, code_edges)
                                       ↓
                                  embed.ts (Voyage code-3, best-effort)
                                       ↓
                                  UPDATE code_nodes.embedding
```

The agent NEVER clones repos or calls GitHub. The caller (CLI in M3.W1,
webhook bridge in M3.W3) supplies file contents + SHA. Keeping the indexer
input-driven means we can run it against a worktree, a tarball, or a webhook
diff without a separate code path.

## Files

| File | Purpose |
|---|---|
| `index.ts` | `IndexerAgent` orchestrator — `upsertRepo(repoId, sha, files)` |
| `parser.ts` | tree-sitter wrapper for TS/TSX → `ParsedFile` |
| `upsert.ts` | Transactional upsert for nodes, edges, and error rows |
| `embed.ts` | Voyage AI client with batching + retry/backoff |
| `pg-client.ts` | `pg` pool factory, env-driven, lazy |
| `types.ts` | `CodeNode`, `CodeEdge`, `ParsedFile`, `IndexResult` |
| `__tests__/` | Parser unit tests + upsert idempotency (against optional local pgvector) |

## Why `pg` instead of `postgres.js`

- Larger install base, more vetted in the IFleet stack already (Octokit,
  better-sqlite3 are similarly mature defaults).
- pgvector integration is a no-op — we send the embedding as a `[1,2,...]`
  text literal and Postgres casts to `vector`. No extra driver layer.
- Pool semantics map cleanly to the orchestrator's connection model.

`postgres.js` has cleaner ergonomics but its template-literal API would
require either every callsite to use template strings or a thin shim — extra
code for no measurable benefit at our scale.

## Failure handling

| Failure | Behavior |
|---|---|
| `IFLEET_KG_DATABASE_URL` missing | Throw `KgPostgresUnavailableError` with a pointer to `.env.example`. The architect's existing grep-based context still works. |
| Tree-sitter parse error on a file | Skip the file, append to `indexer_errors`, continue with the rest. |
| Voyage 429 / 5xx | Exponential backoff (4 attempts). After that, nodes stay in the table with `embedding IS NULL`; the next run picks them up. |
| `VOYAGE_API_KEY` missing | Symbolic-only mode — index runs without embeddings, no error. |

## Smoke test

```
pnpm graph:migrate
IFLEET_KG_ENABLED=1 pnpm graph:index weautomatehq1/IFleet .
```

Outputs the `IndexResult` JSON to stdout. With Voyage key present, fills
`code_nodes.embedding` for every symbol with a signature/docstring.

## Architect integration (deferred to M3.W3)

`src/agents/architect/tools/query_code_graph.ts` is a stub at M3.W1. It
returns an empty result and logs "not yet integrated" so the architect can
import the tool without any behavior change. Wiring into the planning loop
ships once the cold-start index is verified end-to-end against a real repo.
