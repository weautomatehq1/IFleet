// M5 — proposer-side approval-gate seam.
//
// Thin delegation to `src/discord/proposals.ts` so the orchestrator
// (src/agents/proposer/index.ts) keeps its single stable import point:
//   import { postProposalsForApproval } from './approval-gate.js';
//
// The real Discord posting + DB write lives in `src/discord/proposals.ts`
// to keep file ownership clean (Discord adapters live under src/discord).
// This wrapper exists because T3's orchestrator already imports from this
// path; rerouting the import would have churned T3's done-report contract.
//
// Production needs a live discord.js `Client`; we resolve one lazily via
// `proposerDiscordClient()` which is registered at daemon boot. A null
// client falls into the dry-run path (logs + returns 0) so cron runs that
// happen before the daemon has come up cannot crash.

import type { Client } from 'discord.js';

import {
  discordPostDepsFromClient,
  postProposalsForApproval as postProposalsForApprovalImpl,
  type DiscordPostDeps,
} from '../../discord/proposals.js';
import type { DedupedCandidate, ProposerConfig } from './types.js';

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
  candidates: DedupedCandidate[],
  cfg: ProposerConfig,
  depsOverride?: DiscordPostDeps,
): Promise<number> {
  const deps = depsOverride ?? (cachedClient ? discordPostDepsFromClient(cachedClient) : null);
  if (!deps) {
    console.warn(
      '[proposer/approval-gate] no Discord client registered — skipping ' +
        `${candidates.length} candidates. Daemon must call registerProposerDiscordClient() at boot.`,
    );
    return 0;
  }
  return postProposalsForApprovalImpl(candidates, cfg, deps);
}
