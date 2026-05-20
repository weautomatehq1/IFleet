/**
 * Postgres upsert layer for code_nodes + code_edges + indexer_errors.
 *
 * Conflict resolution per the schema (deploy/postgres/0001-knowledge-graph.sql):
 *   - code_nodes is unique on (repo_id, path, name, kind) — we ON CONFLICT and
 *     refresh sha + signature + docstring + line ranges, leaving the embedding
 *     intact unless the source changed (embed.ts re-runs lazily).
 *   - code_edges PK is (src_id, dst_id, kind) — ON CONFLICT DO NOTHING.
 *
 * Edge srcKey/dstKey are translated to ids via the per-batch identity map. Edges
 * to unknown keys (e.g. `imports` pointing at an unresolved module specifier)
 * are dropped silently. M3.W4's cross-repo work upgrades those to real links.
 */

import type { PoolClient } from 'pg';
import type { CodeEdge, CodeNode, ParsedFile } from './types.js';
import { nodeKey } from './types.js';

export interface UpsertSummary {
  nodesUpserted: number;
  edgesUpserted: number;
  edgesDroppedUnresolved: number;
}

export async function upsertParsedFiles(
  client: PoolClient,
  files: ReadonlyArray<ParsedFile>,
): Promise<UpsertSummary> {
  let nodesUpserted = 0;
  let edgesUpserted = 0;
  let edgesDroppedUnresolved = 0;

  // Map key -> id, populated as we upsert nodes so edges can resolve in the
  // same transaction.
  const idByKey = new Map<string, number>();

  await client.query('BEGIN');
  try {
    for (const file of files) {
      for (const node of file.nodes) {
        const id = await upsertNode(client, node);
        idByKey.set(nodeKey(node), id);
        nodesUpserted += 1;
      }
    }
    for (const file of files) {
      for (const edge of file.edges) {
        const srcId = idByKey.get(edge.srcKey);
        const dstId = idByKey.get(edge.dstKey);
        if (srcId === undefined || dstId === undefined) {
          edgesDroppedUnresolved += 1;
          continue;
        }
        await upsertEdge(client, srcId, dstId, edge.kind);
        edgesUpserted += 1;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { nodesUpserted, edgesUpserted, edgesDroppedUnresolved };
}

async function upsertNode(client: PoolClient, node: CodeNode): Promise<number> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO code_nodes (repo_id, path, kind, name, start_line, end_line, sha, signature, docstring)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (repo_id, path, name, kind) DO UPDATE
       SET start_line = EXCLUDED.start_line,
           end_line   = EXCLUDED.end_line,
           sha        = EXCLUDED.sha,
           signature  = EXCLUDED.signature,
           docstring  = EXCLUDED.docstring,
           indexed_at = now()
     RETURNING id`,
    [
      node.repoId,
      node.path,
      node.kind,
      node.name,
      node.startLine ?? null,
      node.endLine ?? null,
      node.sha,
      node.signature ?? null,
      node.docstring ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`upsertNode returned no row for ${nodeKey(node)}`);
  return Number(row.id);
}

async function upsertEdge(
  client: PoolClient,
  srcId: number,
  dstId: number,
  kind: CodeEdge['kind'],
): Promise<void> {
  await client.query(
    `INSERT INTO code_edges (src_id, dst_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [srcId, dstId, kind],
  );
}

export async function logIndexerError(
  client: PoolClient,
  args: {
    repoId: string;
    path: string;
    sha: string;
    stage: 'parse' | 'upsert' | 'embed' | 'io';
    message: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO indexer_errors (repo_id, path, sha, stage, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.repoId, args.path, args.sha, args.stage, args.message.slice(0, 4000)],
  );
}
