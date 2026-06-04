// Lane T4 owns this file.
//
// `enforceBudget` takes scored+deduped candidates, drops anything with
// `dropped === true`, sorts by `composite_score` descending, and slices to
// `min(cfg.budget, cfg.hardMax)`. Stubbed until T4 lands.

import type {
  DedupedCandidate,
  ProposerConfig,
} from './types.ts';

export async function enforceBudget(
  _scored: DedupedCandidate[],
  _cfg: ProposerConfig,
): Promise<DedupedCandidate[]> {
  throw new Error(
    'Lane T4 not landed yet — budget stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
