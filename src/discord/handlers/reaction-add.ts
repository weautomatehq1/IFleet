import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import type { ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import type {
  ControlCommand,
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';

export interface ReactionDeps {
  router: ChannelRouter;
  controlPlane: ControlPlaneClient;
  /** Resolve a thread/message id to the taskId it was opened for. T5 owns the mapping. */
  resolveTaskIdFromMessage: (
    channelId: string,
    messageId: string,
  ) => Promise<string | null> | string | null;
  log?: (msg: string) => void;
}

const APPROVE_EMOJI = '✅';
const REJECT_EMOJI = '❌';

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  deps: ReactionDeps,
): Promise<void> {
  if (user.bot) return;

  // Partial reaction → fetch full to inspect emoji + message.
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const emoji = reaction.emoji.name;
  if (emoji !== APPROVE_EMOJI && emoji !== REJECT_EMOJI) return;

  const channelId = reaction.message.channelId;
  const messageId = reaction.message.id;
  const route = deps.router.resolve(channelId);
  if (!route) return;
  if (!route.allowedUserIds.includes(user.id)) {
    deps.log?.(`[discord] reaction from ${user.id} ignored (not in allowedUserIds for ${route.repo})`);
    return;
  }

  const taskId = await deps.resolveTaskIdFromMessage(channelId, messageId);
  if (!taskId) {
    deps.log?.(`[discord] reaction on ${messageId} but no taskId mapping found`);
    return;
  }

  const source: DiscordCommandSource = {
    kind: 'discord',
    channelId,
    messageId,
    userId: user.id,
    userLabel: user.username ?? user.id,
  };

  const command: ControlCommand =
    emoji === APPROVE_EMOJI
      ? { type: 'approve', taskId, source }
      : { type: 'cancel', taskId, reason: 'rejected via discord reaction', source };

  try {
    await deps.controlPlane.postCommand(command);
  } catch (err) {
    deps.log?.(`[discord] reaction dispatch failed: ${err instanceof Error ? err.message : err}`);
  }
}
