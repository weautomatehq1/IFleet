// Lane T4 owns this file.
//
// `generateCandidates` runs Haiku over a `ProposerContext` and returns 5-20
// candidate goals aligned with SPRINT.md, excluding NON_GOALS items. Until T4
// lands its real implementation, the stub throws — the orchestrator's tests
// mock this module, so `pnpm tsc --noEmit` and the skeleton tests still pass.
//
// See splits/20260604-0910-m5-proposer-substrate/MASTER.md for the lane map.

import type { Candidate, ProposerConfig, ProposerContext } from './types.ts';

export async function generateCandidates(
  _ctx: ProposerContext,
  _cfg: ProposerConfig,
): Promise<Candidate[]> {
  throw new Error(
    'Lane T4 not landed yet — candidate-gen stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
