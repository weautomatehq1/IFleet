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

import type { Client } from 'discord.js';

import type {
  DedupedCandidate,
  ProposerConfig,
} from './types.ts';

let cachedClient: Client | null = null;

/**
 * Daemon boot calls this once it owns a logged-in discord.js Client. The
 * proposer cron runs in the same process (PM2 `ifleet-proposer`), so the
 * shared client is reused — no second login.
 */
export function registerProposerDiscordClient(client: Client): void {
  cachedClient = client;
}

/** Test seam. */
export function _resetProposerDiscordClient(): void {
  cachedClient = null;
}

export async function postProposalsForApproval(
  _top: DedupedCandidate[],
  _cfg: ProposerConfig,
): Promise<number> {
  if (!cachedClient) {
    console.warn(
      '[proposer/approval-gate] no Discord client registered — skipping candidates. ' +
        'Daemon must call registerProposerDiscordClient() at boot.',
    );
    return 0;
  }
  throw new Error(
    'Lane T5 not landed yet — approval-gate stub. See splits/20260604-0910-m5-proposer-substrate/MASTER.md',
  );
}
