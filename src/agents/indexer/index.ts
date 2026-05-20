/**
 * IndexerAgent — entry point for cold-start indexing (M3.W1) and the future
 * incremental webhook path (M3.W3).
 *
 * Responsibility:
 *   1. Walk the provided file list, parse each TS/TSX file with parser.ts.
 *   2. Upsert nodes + edges in a single transaction per repo via upsert.ts.
 *   3. Optionally request embeddings for new/changed nodes via embed.ts.
 *      Embeddings are best-effort — failure here never aborts the index run.
 *   4. Record per-file failures to `indexer_errors` so coverage drift is auditable.
 *
 * Boundary:
 *   - Does NOT clone repos or hit GitHub. The caller (CLI in M3.W1, webhook
 *     bridge in M3.W3) supplies the file contents and SHA.
 *   - Does NOT call the architect. The architect queries the graph via its
 *     own tool (query_code_graph), kept separate so indexing failures cannot
 *     break planning.
 */

import { withKgClient, KgPostgresUnavailableError, encodeVector } from './pg-client.js';
import { parseTypeScriptFile } from './parser.js';
import { upsertParsedFiles, logIndexerError } from './upsert.js';
import {
  EmbeddingProviderUnavailableError,
  TARGET_VECTOR_DIMS,
  VoyageEmbeddingClient,
  type EmbeddingClient,
} from './embed.js';
import type { IndexResult, ParsedFile } from './types.js';

export interface IndexerFile {
  path: string;
  /** Raw source contents — UTF-8. */
  source: string;
}

export interface IndexerAgentOptions {
  /** Override the embedding client (tests pass a stub). */
  embedder?: EmbeddingClient | null;
  /** Override the clock for tests. */
  now?: () => number;
}

export class IndexerAgent {
  private readonly now: () => number;
  private readonly embedder: EmbeddingClient | null;

  constructor(opts: IndexerAgentOptions = {}) {
    this.now = opts.now ?? Date.now;
    if (opts.embedder === undefined) {
      this.embedder = createDefaultEmbedderOrNull();
    } else {
      this.embedder = opts.embedder;
    }
  }

  /**
   * Index a set of files for the given repo @ sha. Files outside TS/TSX are
   * skipped (parser coverage is TS-only at M3.W1; M3.W5 adds Python + Go).
   */
  async upsertRepo(repoId: string, sha: string, files: ReadonlyArray<IndexerFile>): Promise<IndexResult> {
    const started = this.now();
    let filesParsed = 0;
    let filesSkipped = 0;
    const parsed: ParsedFile[] = [];
    const errors: IndexResult['errors'] = [];

    for (const f of files) {
      if (!isParseable(f.path)) {
        filesSkipped += 1;
        continue;
      }
      const result = parseTypeScriptFile({
        repoId,
        path: f.path,
        source: f.source,
        sha,
      });
      if (result.parseError) {
        (errors as Array<IndexResult['errors'][number]>).push({
          path: f.path,
          stage: 'parse',
          message: result.parseError,
        });
        filesSkipped += 1;
        continue;
      }
      parsed.push(result);
      filesParsed += 1;
    }

    let nodesUpserted = 0;
    let edgesUpserted = 0;
    let embeddingsRequested = 0;
    let embeddingsCached = 0;

    try {
      await withKgClient(async client => {
        const summary = await upsertParsedFiles(client, parsed);
        nodesUpserted = summary.nodesUpserted;
        edgesUpserted = summary.edgesUpserted;

        for (const err of errors) {
          await logIndexerError(client, { repoId, path: err.path, sha, stage: err.stage, message: err.message });
        }

        if (this.embedder) {
          const targets = collectEmbeddingTargets(parsed);
          embeddingsRequested = targets.length;
          if (targets.length > 0) {
            try {
              const vectors = await this.embedder.embedBatch(targets.map(t => t.text));
              for (let i = 0; i < targets.length; i += 1) {
                const v = vectors[i];
                if (!v || v.length !== TARGET_VECTOR_DIMS) continue;
                const t = targets[i];
                if (!t) continue;
                await client.query(
                  `UPDATE code_nodes SET embedding = $1::vector
                   WHERE repo_id = $2 AND path = $3 AND name = $4 AND kind = $5`,
                  [encodeVector(v), repoId, t.path, t.name, t.kind],
                );
                embeddingsCached += 1;
              }
            } catch (err) {
              (errors as Array<IndexResult['errors'][number]>).push({
                path: '<embedder>',
                stage: 'embed',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      });
    } catch (err) {
      if (err instanceof KgPostgresUnavailableError || err instanceof EmbeddingProviderUnavailableError) {
        (errors as Array<IndexResult['errors'][number]>).push({
          path: '<infra>',
          stage: err instanceof KgPostgresUnavailableError ? 'io' : 'embed',
          message: err.message,
        });
      } else {
        throw err;
      }
    }

    return {
      repoId,
      sha,
      filesParsed,
      filesSkipped,
      nodesUpserted,
      edgesUpserted,
      embeddingsRequested,
      embeddingsCached,
      durationMs: this.now() - started,
      errors,
    };
  }
}

function isParseable(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.tsx');
}

interface EmbeddingTarget {
  path: string;
  name: string;
  kind: string;
  text: string;
}

function collectEmbeddingTargets(parsed: ReadonlyArray<ParsedFile>): EmbeddingTarget[] {
  const out: EmbeddingTarget[] = [];
  for (const f of parsed) {
    for (const n of f.nodes) {
      // Skip file-kind nodes — embedding the path string is low signal.
      if (n.kind === 'file') continue;
      const text = [n.signature ?? n.name, n.docstring ?? ''].filter(Boolean).join('\n');
      if (!text.trim()) continue;
      out.push({ path: n.path, name: n.name, kind: n.kind, text });
    }
  }
  return out;
}

function createDefaultEmbedderOrNull(): EmbeddingClient | null {
  if (!process.env.VOYAGE_API_KEY) return null;
  try {
    return new VoyageEmbeddingClient();
  } catch {
    return null;
  }
}

export { parseTypeScriptFile } from './parser.js';
export { encodeVector, getKgPool, withKgClient, KgPostgresUnavailableError } from './pg-client.js';
export type { IndexResult, CodeNode, CodeEdge, CodeNodeKind, CodeEdgeKind } from './types.js';
