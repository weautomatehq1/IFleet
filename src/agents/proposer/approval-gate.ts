// Lane T5 owns this file (proposer-side surface).
//
// `postProposalsForApproval` writes one row per candidate into
// `goal_proposals`, posts a Discord message per candidate in #ifleet-proposals,
// and returns the count actually posted. T5's PR replaces this stub.
//
// NB: this lives in the proposer module instead of `src/orchestrator/
// approval-gate.ts` because the existing approval-gate is about
// architect-plan HITL, whose verdict union is `'approve' | 'reject' |
// 'cancel'`. T5 extends that gate with a `kind: 'proposal'` flavour AND
// exposes the proposer-side entry point here so the orchestrator stays
// importing one stable function.

import type {
  DedupedCandidate,
  ProposerConfig,
} from './types.ts';

export async function postProposalsForApproval(
  _top: DedupedCandidate[],
  _cfg: ProposerConfig,
): Promise<number> {
  throw new Error(
    'Lane T5 not landed yet — approval-gate stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
