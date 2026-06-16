// M6-T1 — drift-detector entry point.
//
// `runDriftScan` reads symbol observations from the M3 knowledge graph
// (`code_nodes`), feeds them into the pure `compareDrift` comparator,
// and returns a structured `DriftScanResult`. Does NOT open PRs — the
// substrate stops at the plan.
//
// Failure mode: a missing/unreachable KG returns an empty result with a
// single warn line. Drift detection is a learning signal, not a
// correctness gate; never crash the daemon over it.

import type { Pool } from 'pg';

import { getKgPool, KgPostgresUnavailableError } from '../indexer/pg-client.js';
import { compareDrift } from './compare.js';
import type {
  DriftCandidate,
  DriftKind,
  DriftScanResult,
  SymbolObservation,
} from './types.js';

export interface RunDriftScanOptions {
  /**
   * Repos to scan against — also the `peerRepos` universe for the
   * rename_or_deletion test. Typically the active repo set from
   * config/channels.json, but the caller passes it explicitly so this
   * module has no inbound coupling on the routing layer.
   */
  repos: string[];
  /**
   * Optional kind filter — by default we look at function + class +
   * type because those are the surfaces drift PRs are cheapest to write
   * against. Pass an empty array to include every kind.
   */
  kinds?: SymbolObservation['kind'][];
  /** Override the pool; tests inject. */
  pool?: Pool;
  /** Override the clock; tests inject. */
  now?: () => Date;
  /** Override console.warn; tests capture. */
  warn?: (line: string) => void;
}

const DEFAULT_KINDS: SymbolObservation['kind'][] = ['function', 'class', 'type', 'interface'];

export async function runDriftScan(opts: RunDriftScanOptions): Promise<DriftScanResult> {
  const now = opts.now ?? (() => new Date());
  const warn = opts.warn ?? ((l) => console.warn(l));
  const scannedAt = now().toISOString();

  if (opts.repos.length < 2) {
    warn('[drift-detector] scan needs ≥2 repos — got ' + opts.repos.length + '; returning empty result');
    return emptyResult(scannedAt, opts.repos);
  }

  let observations: SymbolObservation[];
  try {
    observations = await loadObservations(opts.repos, opts.kinds ?? DEFAULT_KINDS, opts.pool);
  } catch (err) {
    if (err instanceof KgPostgresUnavailableError) {
      warn('[drift-detector] KG unavailable: ' + err.message);
      return emptyResult(scannedAt, opts.repos);
    }
    warn(
      '[drift-detector] loadObservations failed: ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return emptyResult(scannedAt, opts.repos);
  }

  const candidates = compareDrift(observations, { peerRepos: opts.repos });
  return {
    scannedAt,
    reposScanned: [...opts.repos].sort(),
    symbolsCompared: observations.length,
    candidates,
    summary: summarise(candidates),
  };
}

function emptyResult(scannedAt: string, repos: string[]): DriftScanResult {
  return {
    scannedAt,
    reposScanned: [...repos].sort(),
    symbolsCompared: 0,
    candidates: [],
    summary: emptySummary(),
  };
}

function emptySummary(): Record<DriftKind, number> {
  return { signature_skew: 0, rename_or_deletion: 0, orphan_reference: 0 };
}

function summarise(cands: DriftCandidate[]): Record<DriftKind, number> {
  const out = emptySummary();
  for (const c of cands) out[c.driftKind] += 1;
  return out;
}

async function loadObservations(
  repos: string[],
  kinds: SymbolObservation['kind'][],
  pool: Pool = getKgPool(),
): Promise<SymbolObservation[]> {
  // `latest_signature` per (repo_id, name, kind) — the same symbol can
  // be indexed multiple times across files (e.g. re-exported). We
  // collapse on the (repo_id, name, kind) triple and pick the most
  // recently indexed row's signature; the comparator already buckets
  // by signature so duplicates in the result are harmless but noisy.
  const params: unknown[] = [repos];
  let kindClause = '';
  if (kinds.length > 0) {
    params.push(kinds);
    kindClause = `AND kind = ANY($${params.length}::text[])`;
  }
  const result = await pool.query<{
    repo_id: string;
    path: string;
    name: string;
    kind: SymbolObservation['kind'];
    signature: string | null;
  }>(
    `SELECT DISTINCT ON (repo_id, name, kind)
            repo_id, path, name, kind, signature
       FROM code_nodes
      WHERE repo_id = ANY($1::text[])
        ${kindClause}
        AND name <> ''
        AND kind <> 'file'
      ORDER BY repo_id, name, kind, indexed_at DESC`,
    params,
  );
  return result.rows.map((r) => ({
    repoId: r.repo_id,
    path: r.path,
    name: r.name,
    kind: r.kind,
    signature: r.signature,
  }));
}
