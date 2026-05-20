/**
 * IndexerAgent types — shared contract for the symbol graph (`code_nodes` +
 * `code_edges`) and the embedding pipeline. See ADR-0003 and
 * docs/elevation/upgrades/03-knowledge-graph.md.
 */

export type CodeNodeKind =
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'type'
  | 'interface'
  | 'const'
  | 'enum';

export type CodeEdgeKind =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'uses_type'
  | 'contains';

/**
 * Symbol extracted by the tree-sitter parser. `name` is the local symbol name;
 * for file nodes it equals `path`. `id` is assigned by Postgres on upsert and
 * filled in after `upsertNodes`.
 */
export interface CodeNode {
  repoId: string;
  path: string;
  kind: CodeNodeKind;
  name: string;
  startLine?: number;
  endLine?: number;
  sha: string;
  signature?: string;
  docstring?: string;
  /** Filled in by upsert.ts; undefined until then. */
  id?: number;
}

/**
 * Edge between two symbols. The parser emits edges by (srcKey, dstKey) where
 * keys are the same identity tuple used for `code_nodes` uniqueness:
 * `${path}::${kind}::${name}`. upsert.ts resolves keys to ids before insert.
 */
export interface CodeEdge {
  srcKey: string;
  dstKey: string;
  kind: CodeEdgeKind;
}

export interface ParsedFile {
  path: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  parseError?: string;
}

export interface IndexResult {
  repoId: string;
  sha: string;
  filesParsed: number;
  filesSkipped: number;
  nodesUpserted: number;
  edgesUpserted: number;
  embeddingsRequested: number;
  embeddingsCached: number;
  durationMs: number;
  errors: ReadonlyArray<{ path: string; stage: 'parse' | 'upsert' | 'embed' | 'io'; message: string }>;
}

export const nodeKey = (n: { path: string; kind: CodeNodeKind; name: string }): string =>
  `${n.path}::${n.kind}::${n.name}`;
