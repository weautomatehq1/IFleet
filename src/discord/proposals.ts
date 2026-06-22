// M5 — Discord posting + DB row insert for goal proposals.
//
// One DedupedCandidate → one row in `goal_proposals` (id = generated UUID)
// → one message in #ifleet-proposals with three buttons:
//   - `proposal_approve:<id>` — write decision='approved'
//   - `proposal_reject:<id>`  — write decision='rejected'
//   - `proposal_defer:<id>`   — write decision='deferred'
//
// Button clicks are routed by `src/discord/handlers/interaction-create.ts`
// to `recordProposalDecision` in `src/orchestrator/approval-gate.ts`.
//
// IFLEET_PROPOSALS_CHANNEL_ID gates the post. When unset, the function
// logs and returns 0 — a missing channel is "not enabled yet" not "error".
// The channel is hand-created in Discord (see PR body); env var resolution
// happens at post-time so the daemon can be redeployed without a restart
// after Sebastian sets the value in /etc/environment.

import { randomUUID } from 'node:crypto';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type TextBasedChannel,
} from 'discord.js';

import { insertProposal } from '../orchestrator/goal-proposals-store.js';
import type {
  DedupedCandidate,
  ProposerConfig,
} from '../agents/proposer/types.js';

/**
 * Resolve the proposals channel id. Returns `null` when the env var is
 * unset — caller treats that as "feature disabled, skip post."
 *
 * Precedence:
 *   1. `cfg.discordChannelId` (test override / multi-channel future)
 *   2. `IFLEET_PROPOSALS_CHANNEL_ID` env var
 */
export function getProposalsChannelId(cfg: ProposerConfig): string | null {
  if (cfg.discordChannelId && cfg.discordChannelId.length > 0) {
    return cfg.discordChannelId;
  }
  const envValue = process.env['IFLEET_PROPOSALS_CHANNEL_ID'];
  if (envValue && envValue.length > 0) return envValue;
  return null;
}

/**
 * Minimal discord.js seam — we only need the `channels.fetch` API plus the
 * channel's `.send()`. Stating it explicitly lets tests inject a fake
 * without dragging a whole `Client` mock through.
 */
export interface DiscordPostDeps {
  fetchChannel(channelId: string): Promise<TextBasedChannel | null>;
  /** Override the id generator — tests pin determinism. */
  generateId?: () => string;
  /** Override `console.warn` — tests capture. */
  warn?: (line: string) => void;
}

/** Production wiring: pass `client` and we expose the right surface. */
export function discordPostDepsFromClient(client: Client): DiscordPostDeps {
  return {
    async fetchChannel(channelId): Promise<TextBasedChannel | null> {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return null;
        return channel as TextBasedChannel;
      } catch (err) {
        console.warn(
          `[proposals] channels.fetch(${channelId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  };
}

const CUSTOM_ID_VERBS = {
  approve: 'proposal_approve',
  reject: 'proposal_reject',
  defer: 'proposal_defer',
} as const;

function formatMessage(candidate: DedupedCandidate): string {
  const value = candidate.estimated_value.toFixed(2);
  const difficulty = candidate.estimated_difficulty.toFixed(2);
  const composite = candidate.composite_score.toFixed(2);
  return [
    `**${candidate.title}**`,
    candidate.rationale,
    '',
    `source: \`${candidate.source}\` · value: \`${value}\` · difficulty: \`${difficulty}\` · composite: \`${composite}\``,
  ].join('\n');
}

function buildButtonRow(proposalId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_VERBS.approve}:${proposalId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_VERBS.reject}:${proposalId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_VERBS.defer}:${proposalId}`)
      .setLabel('Defer')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Insert one row per non-dropped candidate, then post a message per row to
 * #ifleet-proposals. Returns the count of messages successfully posted.
 *
 * Failure semantics:
 *   - Channel id unset → log + return 0 (feature gate).
 *   - Channel fetch returns null → log + return 0 (channel missing).
 *   - Per-candidate post failure → log + skip that candidate; no row inserted.
 *     Ordering is send-then-insert so a failed Discord post can't leave an
 *     orphan row that has no message to be approved/rejected against.
 *   - DB insert failure (after successful send) → bubble up; the Discord
 *     message is already live and a subsequent button click will surface the
 *     missing row as a recordProposalDecision error rather than rotting.
 *
 * Dry-run: `cfg.dryRun === true` skips both DB writes and Discord posts;
 * returns 0. Used by smoke tests + initial deploys before #ifleet-proposals
 * exists.
 */
export async function postProposalsForApproval(
  candidates: DedupedCandidate[],
  cfg: ProposerConfig,
  deps: DiscordPostDeps,
): Promise<number> {
  const warn = deps.warn ?? ((l) => console.warn(l));
  if (cfg.dryRun) {
    warn(`[proposals] dry-run — skipping ${candidates.length} posts`);
    return 0;
  }
  const live = candidates.filter((c) => !c.dropped);
  if (live.length === 0) return 0;

  const channelId = getProposalsChannelId(cfg);
  if (!channelId) {
    warn(
      '[proposals] IFLEET_PROPOSALS_CHANNEL_ID is unset — skipping Discord post (rows NOT inserted). Set the env var after creating #ifleet-proposals.',
    );
    return 0;
  }
  const channel = await deps.fetchChannel(channelId);
  if (!channel) {
    warn(`[proposals] channel ${channelId} not reachable — skipping post (rows NOT inserted).`);
    return 0;
  }
  if (!('send' in channel) || typeof channel.send !== 'function') {
    warn(`[proposals] channel ${channelId} does not support send() — skipping.`);
    return 0;
  }

  const generateId = deps.generateId ?? (() => randomUUID());

  let posted = 0;
  for (const candidate of live) {
    const proposalId = generateId();
    await insertProposal({
      id: proposalId,
      repo_id: cfg.repoId,
      source: candidate.source,
      title: candidate.title,
      rationale: candidate.rationale,
      estimated_value: candidate.estimated_value,
      estimated_difficulty: candidate.estimated_difficulty,
      embedding: null,
    });
    try {
      await channel.send({
        content: formatMessage(candidate),
        components: [buildButtonRow(proposalId)],
      });
    } catch (err) {
      warn(
        `[proposals] post failed for ${proposalId}: ${err instanceof Error ? err.message : String(err)} — DB row inserted, Discord message missing`,
      );
      continue;
    }
    posted += 1;
  }
  return posted;
}
