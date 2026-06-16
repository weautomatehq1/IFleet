// Lane T4 owns this file.
//
// `scoreCandidates` attaches `sprint_alignment` and `composite_score` to each
// candidate per the rubric in upgrades/06-goal-driven.md §"Pipeline step →
// Score & filter". The scorer is purely additive — it must not drop fields.

import type {
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
} from './types.ts';

export async function scoreCandidates(
  _candidates: DedupedCandidate[],
  _ctx: ProposerContext,
  _cfg: ProposerConfig,
): Promise<DedupedCandidate[]> {
  throw new Error(
    'Lane T4 not landed yet — scorer stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
