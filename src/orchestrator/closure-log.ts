// Routing-decision closure log — emits one [ROUTING-DECISION-LOG] JSON line per
// dispatched task so downstream analysis can compute post-fix false-positive rate
// (e.g. tasks that hit a HIGH_KEYWORD → Opus but whose PR was trivially merged).
//
// Shape kept in sync with scorer.ts [PROPOSER-TELEMETRY] for grep-compat.

export interface RoutingDecisionLogEntry {
  /** Task ID — correlates with goal_proposals.resulting_pr_outcome. */
  task_id: string;
  /** First HIGH_KEYWORD that triggered Opus promotion, or null when none hit. */
  hit_keyword: string | null;
  /** Final architect tier after all overrides (scorer + labels + mode). */
  final_tier: 'haiku' | 'sonnet' | 'opus';
  /** Raw keyword score before label bumps and rule overrides. */
  raw_score: number;
  /** ISO-8601 timestamp of the routing decision. */
  decided_at: string;
}

export function writeRoutingDecisionLog(
  entry: RoutingDecisionLogEntry,
  sink: (line: string) => void = (l) => console.warn(l),
): void {
  sink(`[ROUTING-DECISION-LOG] ${JSON.stringify(entry)}`);
}
