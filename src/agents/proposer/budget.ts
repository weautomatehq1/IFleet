// M5 Proposer — budget gate (Lane T4).
//
// `enforceBudget` filters out `dropped` entries, sorts by composite_score
// desc, and slices to `min(cfg.budget, cfg.hardMax, HARD_CEILING)`. The
// HARD_CEILING is a constant safety net (10 per upgrades/06-goal-driven.md
// §"Enforce budget") so that even a misconfigured `cfg.hardMax` cannot
// produce a runaway nightly run.

import type { DedupedCandidate, ProposerConfig } from './types.js';

/** Spec ceiling — never exceed this regardless of cfg.budget / cfg.hardMax. */
const HARD_CEILING = 10;

export function enforceBudget(
  candidates: DedupedCandidate[],
  cfg: ProposerConfig,
): DedupedCandidate[] {
  const kept = candidates.filter((c) => !c.dropped);
  kept.sort((a, b) => b.composite_score - a.composite_score);
  const budget = Math.max(0, Math.floor(cfg.budget));
  const hardMax = Math.max(0, Math.floor(cfg.hardMax));
  const cap = Math.min(budget, hardMax, HARD_CEILING);
  return kept.slice(0, cap);
}
