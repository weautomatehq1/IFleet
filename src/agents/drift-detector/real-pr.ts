// M6 closure substrate — drift "real-PR" planner.
//
// The drift detector's report-only path (scripts/drift-scan-run.ts) posts a
// digest to Discord and stops. This module is the OTHER side of the
// `DRIFT_REAL_PR` flag: when the operator flips it ON (after the
// candidate-merge-rate KPI clears ≥70%), the scan's flagged drift candidates
// are grouped into candidate-PR plans — one per source-of-truth repo — and
// handed to the emitter so a remediation PR can be opened against each
// diverging peer.
//
// This module is PURE: it turns a `DriftScanResult` into a list of
// `DriftPrPlan`s. It does NOT open PRs and it does NOT call GitHub — per the
// architecture rule, GitHub interactions flow through the queue bridge layer,
// so the emitter (injected at the cron entrypoint) owns that. Keeping the
// planner pure makes the OFF path provably untouched and the ON path easy to
// unit-test from literal fixtures.

import { createHash } from 'node:crypto';

import type { DriftCandidate, DriftScanResult } from './types.js';

/** Standard GitHub label every drift-PR carries so reviewers can filter. */
export const DRIFT_AUDIT_LABEL = 'audit:drift';

/**
 * One candidate-PR plan, anchored to a single source-of-truth repo. The
 * source-of-truth repo is the majority-signature repo (`groups[0]`) — the
 * canonical shape the outlier peers should be aligned to. `targetRepos` is
 * the union of outlier repos across the bundled candidates: the peers a
 * remediation PR would touch.
 */
export interface DriftPrPlan {
  /** Source-of-truth repo whose signature is canonical for these symbols. */
  sourceRepo: string;
  /** Drift candidates whose majority signature lives in `sourceRepo`. */
  candidates: DriftCandidate[];
  /** Union of outlier repos to bring in line with the source of truth. */
  targetRepos: string[];
  /** One-line PR title (deterministic — stable across identical scans). */
  title: string;
  /** PR body: a checklist of the drifted symbols and their target repos. */
  body: string;
  /**
   * GitHub labels the emitter MUST apply when opening the PR. Always
   * includes `audit:drift` so reviewers can filter the drift-detector
   * output stream away from human work.
   */
  labels: string[];
  /**
   * Per-source-file-SHA idempotency key. `sha256(sourceFileSHA +
   * driftSignature)` where `sourceFileSHA` identifies the canonical-repo
   * files this plan rewrites, and `driftSignature` identifies the symbol
   * set + majority signatures the plan brings peers to. Re-emitting the
   * same key is a no-op: the cron persists keys it has already handed to
   * the emitter and skips them on the next run.
   */
  idempotencyKey: string;
}

/**
 * Pick the source-of-truth repo for one candidate: the first repo of the
 * majority signature group (`groups[0]`), which `compareDrift` already sorts
 * by repo count descending then signature. Repos within a group are
 * dedup-sorted, so `groups[0].repos[0]` is deterministic. Returns null when
 * the majority group has no repos (defensive — shouldn't happen today).
 */
function sourceRepoOf(c: DriftCandidate): string | null {
  return c.groups[0]?.repos[0] ?? null;
}

/**
 * Group a scan's flagged candidates into candidate-PR plans, one per
 * source-of-truth repo. Candidates with no resolvable source repo are
 * skipped (they can't anchor a remediation PR). Output is sorted by
 * `sourceRepo` so identical scans produce identical plans.
 */
export function planDriftPrs(result: DriftScanResult): DriftPrPlan[] {
  const bySource = new Map<string, DriftCandidate[]>();
  for (const c of result.candidates) {
    const src = sourceRepoOf(c);
    if (src === null) continue;
    const arr = bySource.get(src) ?? [];
    arr.push(c);
    bySource.set(src, arr);
  }

  const plans: DriftPrPlan[] = [];
  for (const [sourceRepo, candidates] of bySource) {
    const targets = new Set<string>();
    for (const c of candidates) {
      for (const r of c.outlierRepos) targets.add(r);
    }
    const targetRepos = Array.from(targets).sort();
    plans.push({
      sourceRepo,
      candidates,
      targetRepos,
      title: `drift: align ${candidates.length} symbol(s) to ${sourceRepo}`,
      body: buildBody(sourceRepo, candidates, targetRepos),
      labels: [DRIFT_AUDIT_LABEL],
      idempotencyKey: computeIdempotencyKey(sourceRepo, candidates),
    });
  }

  // Code-unit sort (not localeCompare) to match the rest of the drift
  // module's `dedupSort`/`.sort()` convention — deterministic across runs.
  plans.sort((a, b) =>
    a.sourceRepo < b.sourceRepo ? -1 : a.sourceRepo > b.sourceRepo ? 1 : 0,
  );
  return plans;
}

function buildBody(
  sourceRepo: string,
  candidates: DriftCandidate[],
  targetRepos: string[],
): string {
  const lines: string[] = [
    `Source of truth: \`${sourceRepo}\``,
    `Target repos: ${targetRepos.map((r) => `\`${r}\``).join(', ') || '(none)'}`,
    '',
    'Drifted symbols:',
  ];
  for (const c of candidates) {
    const outliers = c.outlierRepos.join(', ') || '(none)';
    lines.push(`- [ ] ${c.driftKind} on \`${c.name}\` (${c.kind}) → ${outliers}`);
  }
  return lines.join('\n');
}

/**
 * Stable hex SHA over the source-of-truth files this plan rewrites: the
 * sourceRepo plus the sorted unique file paths the majority signature
 * lives in (`groups[0].paths`). We don't have real git blob SHAs at the
 * planner layer (the KG projection drops them) so this is a structural
 * proxy — same files → same SHA across runs. Used as one half of the
 * per-plan idempotency key.
 */
export function computeSourceFileSha(
  sourceRepo: string,
  candidates: DriftCandidate[],
): string {
  const paths = new Set<string>();
  for (const c of candidates) {
    for (const p of c.groups[0]?.paths ?? []) paths.add(p);
  }
  const sorted = Array.from(paths).sort();
  return createHash('sha256')
    .update(`${sourceRepo}\n${sorted.join('\n')}`)
    .digest('hex');
}

/**
 * Stable hex SHA over the drift signature this plan addresses: the set of
 * (symbolKey, driftKind, majority signature) tuples, sorted by symbolKey.
 * Two scans that flag the same symbols at the same majority signature
 * produce the same driftSignature, even if the candidates are sliced in a
 * different order.
 */
export function computeDriftSignature(candidates: DriftCandidate[]): string {
  const rows = candidates
    .map((c) => {
      const majoritySig = c.groups[0]?.signature ?? '';
      return `${c.symbolKey}\t${c.driftKind}\t${majoritySig}`;
    })
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/**
 * Per-source-file-SHA idempotency key for one plan. `sha256(sourceFileSHA
 * + driftSignature)`. The drift-scan cron persists keys it has already
 * handed to the emitter; a re-run that produces the same drift skips
 * re-emission so the same PR is never opened twice. Deterministic across
 * identical scans — used by both the planner and the idempotency store.
 */
export function computeIdempotencyKey(
  sourceRepo: string,
  candidates: DriftCandidate[],
): string {
  const sourceFileSha = computeSourceFileSha(sourceRepo, candidates);
  const driftSignature = computeDriftSignature(candidates);
  return createHash('sha256')
    .update(`${sourceFileSha}${driftSignature}`)
    .digest('hex');
}
