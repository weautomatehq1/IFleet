// M6-T1 — drift comparator. Pure function: takes a flat list of symbol
// observations (one row per (repo, path, name, kind) in the M3 KG) and
// returns the set of drift candidates.
//
// "Drift" today means one of:
//   1. signature_skew    — same (kind, name) seen in ≥2 repos with ≥2
//                          distinct non-null signatures.
//   2. rename_or_deletion — same (kind, name) seen in some but not all
//                          peers within `peerRepos` (the universe of
//                          repos we EXPECT to share this symbol).
//
// The substrate stops there. The planner (separate file, follow-up
// sprint) decides which candidates become real drift PRs and against
// which repo. M6 closure is gated on a ≥70% merge-rate KPI for those
// PRs, which is why we keep the substrate cheap to iterate on.
//
// Pure by design — no DB calls, no fs, no time. Easy to unit-test from
// literal fixtures and easy to call from a higher-level scan.

import type {
  DriftCandidate,
  DriftKind,
  SymbolObservation,
} from './types.js';

export interface CompareOptions {
  /**
   * Universe of repos that SHOULD share each symbol. When a symbol is
   * present in some of these repos but absent in others, the absent
   * repos become `rename_or_deletion` outliers. Pass an empty array to
   * disable the rename/deletion check (signature_skew still fires).
   */
  peerRepos: string[];
  /**
   * Minimum number of observations per (kind, name) before drift is
   * considered. Default 2 — a one-shot symbol has no drift to detect.
   */
  minObservations?: number;
}

/**
 * Group + classify. Stable sort throughout so the same input always
 * produces the same output bytes (the planner can diff runs).
 */
export function compareDrift(
  observations: readonly SymbolObservation[],
  opts: CompareOptions,
): DriftCandidate[] {
  const minObservations = opts.minObservations ?? 2;
  const peerSet = new Set(opts.peerRepos);

  // Group by (kind, name). Map preserves insertion order; we sort the
  // final candidate list at the end so order is deterministic.
  const byKey = new Map<string, SymbolObservation[]>();
  for (const obs of observations) {
    const key = `${obs.kind}:${obs.name}`;
    const arr = byKey.get(key) ?? [];
    arr.push(obs);
    byKey.set(key, arr);
  }

  const candidates: DriftCandidate[] = [];
  for (const [symbolKey, obsList] of byKey) {
    if (obsList.length < minObservations) continue;

    const firstObs = obsList[0];
    if (!firstObs) continue;
    const name = firstObs.name;
    const kind = firstObs.kind;

    const driftCandidates = classifySymbol(symbolKey, name, kind, obsList, peerSet);
    candidates.push(...driftCandidates);
  }

  // Sort by symbolKey, then by driftKind. The secondary sort matters when
  // one symbol emits both `signature_skew` and `rename_or_deletion`: a
  // bare `symbolKey` sort returns equal under both candidates, and even
  // though Array.sort is stable in modern JS, leaving the tie implicit
  // couples the output to the order classifySymbol() happens to push.
  candidates.sort((a, b) => {
    const k = a.symbolKey.localeCompare(b.symbolKey);
    if (k !== 0) return k;
    return a.driftKind.localeCompare(b.driftKind);
  });
  return candidates;
}

function classifySymbol(
  symbolKey: string,
  name: string,
  kind: SymbolObservation['kind'],
  obsList: readonly SymbolObservation[],
  peerSet: ReadonlySet<string>,
): DriftCandidate[] {
  // Bucket by signature (NULL goes into its own bucket but is excluded
  // from the signature_skew test because a missing signature is not a
  // disagreement — the indexer just couldn't extract one).
  const signatureGroups = bucketBySignature(obsList);

  const out: DriftCandidate[] = [];

  // ---- signature_skew ----
  const nonNullGroups = signatureGroups.filter((g) => g.signature !== null);
  if (nonNullGroups.length >= 2) {
    nonNullGroups.sort((a, b) => b.repos.length - a.repos.length || a.signature!.localeCompare(b.signature!));
    const majorityRepos = new Set(nonNullGroups[0]!.repos);
    const outlierRepos: string[] = [];
    for (const g of nonNullGroups.slice(1)) {
      for (const r of g.repos) {
        if (!majorityRepos.has(r)) outlierRepos.push(r);
      }
    }
    out.push({
      symbolKey,
      name,
      kind,
      driftKind: 'signature_skew' as DriftKind,
      groups: nonNullGroups,
      outlierRepos: dedupSort(outlierRepos),
    });
  }

  // ---- rename_or_deletion ----
  if (peerSet.size > 0) {
    const reposWithSymbol = new Set(obsList.map((o) => o.repoId));
    const missingPeers: string[] = [];
    for (const peer of peerSet) {
      if (!reposWithSymbol.has(peer)) missingPeers.push(peer);
    }
    if (missingPeers.length > 0 && reposWithSymbol.size > 0) {
      const presentGroup = {
        signature: 'present',
        repos: dedupSort(Array.from(reposWithSymbol)),
        paths: dedupSort(obsList.map((o) => o.path)),
      };
      const absentGroup = {
        signature: 'absent',
        repos: dedupSort(missingPeers),
        paths: [] as string[],
      };
      // Sort by repo count desc — majority wins. When 1 repo has the
      // symbol and N peers don't, "absent" is the majority and the
      // outlier is the lone repo that ADDED a symbol the others don't
      // recognize. When N repos have the symbol and 1 peer doesn't,
      // "present" is the majority and the outlier is the laggard.
      const ordered =
        absentGroup.repos.length > presentGroup.repos.length
          ? [absentGroup, presentGroup]
          : [presentGroup, absentGroup];
      const minority = ordered[1]!;
      out.push({
        symbolKey,
        name,
        kind,
        driftKind: 'rename_or_deletion' as DriftKind,
        groups: ordered,
        outlierRepos: minority.repos,
      });
    }
  }

  return out;
}

function bucketBySignature(obsList: readonly SymbolObservation[]): Array<{ signature: string | null; repos: string[]; paths: string[] }> {
  const buckets = new Map<string, { signature: string | null; repos: string[]; paths: string[] }>();
  for (const obs of obsList) {
    // Map key uses a sentinel for null so we don't collide with the
    // empty-string signature (rare but possible).
    const key = obs.signature === null ? '\0NULL\0' : obs.signature;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { signature: obs.signature, repos: [], paths: [] };
      buckets.set(key, bucket);
    }
    bucket.repos.push(obs.repoId);
    bucket.paths.push(obs.path);
  }
  for (const b of buckets.values()) {
    b.repos = dedupSort(b.repos);
    b.paths = dedupSort(b.paths);
  }
  return Array.from(buckets.values());
}

function dedupSort(xs: string[]): string[] {
  return Array.from(new Set(xs)).sort();
}
