// M6-T1 — drift-detector substrate types.
//
// "Drift" = the same logical symbol (same name + kind) has diverged
// across repos in the M3 knowledge graph. This module is the SUBSTRATE:
// it computes drift candidates and emits a plan; it does NOT open PRs.
// M6 closure (separate sprint) decides which candidates become real
// drift PRs, gated on a ≥70% merge-rate KPI.

/**
 * One code symbol observed in one repo. Minimal projection of
 * `code_nodes` for drift comparison — we deliberately do NOT carry the
 * embedding or the symbolic `id` so the compare module is pure and easy
 * to unit-test with literal fixtures.
 */
export interface SymbolObservation {
  repoId: string;
  /** File path the symbol lives in. Useful for the drift-PR plan output. */
  path: string;
  /** Symbol name (`createUser`, `UserService`, etc.). */
  name: string;
  /** Node kind — must match `code_nodes.kind` CHECK values. */
  kind: 'class' | 'function' | 'type' | 'interface' | 'method' | 'const' | 'enum';
  /**
   * Canonical signature text (e.g. `function createUser(input: CreateUserInput): User`).
   * NULL when the indexer couldn't extract one — those rows are ignored
   * by the comparator since "no signature" can't drift.
   */
  signature: string | null;
}

export type DriftKind =
  | 'signature_skew'      // ≥2 distinct non-null signatures for the same (name, kind)
  | 'rename_or_deletion'  // a symbol exists in some repos but not all peers
  | 'orphan_reference';   // future: cross_repo_links → missing target. Not yet emitted.

/**
 * One drift-candidate cluster, fully self-describing for the drift-PR
 * planner. `outlierRepos` is the repos that disagree with the majority
 * — these are the candidates for a remediation PR.
 */
export interface DriftCandidate {
  symbolKey: string;        // `${kind}:${name}` — stable across the run.
  name: string;
  kind: SymbolObservation['kind'];
  driftKind: DriftKind;
  /**
   * One entry per distinct signature seen (signature_skew) or per
   * present/absent group (rename_or_deletion). Sorted by repo count
   * descending so `groups[0]` is the majority signature.
   */
  groups: Array<{ signature: string | null; repos: string[]; paths: string[] }>;
  /** Repos that disagree with `groups[0]`. */
  outlierRepos: string[];
}

/**
 * The substrate's output. `summary` is keyed on drift_kind so the
 * planner can decide which classes to act on first.
 */
export interface DriftScanResult {
  scannedAt: string;
  reposScanned: string[];
  symbolsCompared: number;
  candidates: DriftCandidate[];
  summary: Record<DriftKind, number>;
}
