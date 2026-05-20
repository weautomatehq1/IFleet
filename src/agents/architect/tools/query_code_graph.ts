/**
 * `query_code_graph(query, repo_id?, depth=2)` — architect tool stub.
 *
 * M3.W1 scope: signature only. Returns an empty graph + logs `not yet integrated`
 * so the architect can opt-in to the import path without behavior change. The
 * actual ego-graph traversal + pgvector fallback land in M3.W3 alongside the
 * planning-loop integration.
 *
 * Gating: only runs when `IFLEET_KG_ENABLED=1`. With the flag off (default),
 * the tool no-ops cleanly so existing architect behavior is unchanged.
 *
 * Why a stub now:
 *   - Locks the call signature before the planner depends on it.
 *   - Lets us land the indexer + schema without coupling the architect rollout
 *     to M3.W3 — graph can backfill in the background while architect still
 *     uses the existing grep-based context.
 *   - Avoids the failure mode where M3.W3 tries to introduce both a new tool
 *     AND a new behavior in the same PR.
 */

export interface QueryCodeGraphInput {
  /** Natural-language query — usually the brief title + body. */
  query: string;
  /** Optional repo scope. Omit for cross-repo search. */
  repoId?: string;
  /**
   * Neighbor traversal radius from each matched node. M3.W3 default is 2.
   * Capped at 4 server-side to bound result size.
   */
  depth?: number;
}

export interface CodeGraphNode {
  id: number;
  repoId: string;
  path: string;
  kind: string;
  name: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  /** Cosine similarity when the node was retrieved via embedding fallback. */
  similarity?: number;
}

export interface CodeGraphEdge {
  srcId: number;
  dstId: number;
  kind: string;
}

export interface CrossRepoCandidate {
  srcNodeId: number;
  dstNodeId: number;
  linkKind: string;
  confidence: number;
}

export interface QueryCodeGraphResult {
  /** Matched nodes + neighbors up to `depth` hops. Empty in M3.W1 stub. */
  nodes: ReadonlyArray<CodeGraphNode>;
  edges: ReadonlyArray<CodeGraphEdge>;
  /** Cross-repo candidates surfaced when `repoId` is omitted. Empty in M3.W1 stub. */
  crossRepoCandidates: ReadonlyArray<CrossRepoCandidate>;
  /** Free-form banner the architect surfaces in the plan footer. */
  banner?: string;
  /** True when the call hit the database; false when stub/feature-flag path ran. */
  hitDatabase: boolean;
}

export interface QueryCodeGraphDeps {
  /** Override the log sink (tests). */
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Override the env lookup (tests). */
  envLookup?: (key: string) => string | undefined;
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 4;

export async function queryCodeGraph(
  input: QueryCodeGraphInput,
  deps: QueryCodeGraphDeps = {},
): Promise<QueryCodeGraphResult> {
  const log = deps.logger ?? defaultLogger;
  const envLookup = deps.envLookup ?? (k => process.env[k]);
  const depth = clampDepth(input.depth ?? DEFAULT_DEPTH);

  const enabled = envLookup('IFLEET_KG_ENABLED') === '1';
  if (!enabled) {
    return {
      nodes: [],
      edges: [],
      crossRepoCandidates: [],
      banner: 'kg disabled (IFLEET_KG_ENABLED!=1)',
      hitDatabase: false,
    };
  }

  log('query_code_graph: stub invocation — runtime integration lands in M3.W3', {
    query: input.query.slice(0, 80),
    repoId: input.repoId,
    depth,
  });

  return {
    nodes: [],
    edges: [],
    crossRepoCandidates: [],
    banner: 'kg stub — M3.W3 wires real traversal',
    hitDatabase: false,
  };
}

function clampDepth(d: number): number {
  if (!Number.isFinite(d) || d < 1) return 1;
  if (d > MAX_DEPTH) return MAX_DEPTH;
  return Math.floor(d);
}

function defaultLogger(msg: string, meta?: Record<string, unknown>): void {
  // Use console.warn so the message surfaces in the architect's existing
  // trace sink without requiring a new log channel.
  console.warn(`[architect.query_code_graph] ${msg}`, meta ?? {});
}
