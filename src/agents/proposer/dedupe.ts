// Lane T4 owns this file.
//
// `dedupeCandidates` computes cosine similarity between each candidate's
// embedding and the last 30d of `goal_proposals` embeddings, drops any whose
// `nearest_neighbor_sim` exceeds `cfg.dedupThreshold`, and force-explores one
// low-score for learning (bandit-style). Stubbed until T4 lands.

import type {
  Candidate,
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
} from './types.ts';

export async function dedupeCandidates(
  _candidates: Candidate[],
  _ctx: ProposerContext,
  _cfg: ProposerConfig,
): Promise<DedupedCandidate[]> {
  throw new Error(
    'Lane T4 not landed yet — dedupe stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
