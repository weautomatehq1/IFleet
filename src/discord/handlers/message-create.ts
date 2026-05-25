import type { Client, Message } from 'discord.js';
import type { ChannelRouter } from '../../contracts/channel-router.js';
import type {
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';

export interface MessageCreateDeps {
  router: ChannelRouter;
  controlPlane: ControlPlaneClient;
  client: Pick<Client, 'user'>;
  log?: (msg: string) => void;
}

/** Returned for tests — production handler discards. */
export type MessageCreateOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'posted'; commandType: 'sprint_goal' };

export async function handleMessageCreate(
  message: Message,
  deps: MessageCreateDeps,
): Promise<MessageCreateOutcome> {
  const { router, controlPlane, client } = deps;
  const log = deps.log ?? (() => {});

  if (message.author.bot) return { kind: 'ignored', reason: 'bot author' };

  const route = router.resolve(message.channelId);
  if (!route) return { kind: 'ignored', reason: 'channel not mapped' };

  if (!route.allowedUserIds.includes(message.author.id)) {
    log(`[discord] silently ignoring ${message.author.id} in ${message.channelId} (not in allowedUserIds)`);
    return { kind: 'ignored', reason: 'user not allowed' };
  }

  const raw = (message.content ?? '').slice(0, 10_000).trim();
  if (raw.length === 0) return { kind: 'ignored', reason: 'empty body' };
  if (raw.startsWith('!!')) return { kind: 'ignored', reason: 'debug prefix' };

  // Strip a leading bot mention (e.g. "<@123> ship login page" → "ship login page").
  const botId = client.user?.id;
  const mentionPattern = botId ? new RegExp(`^<@!?${botId}>\\s*`) : null;
  const brief = mentionPattern ? raw.replace(mentionPattern, '').trim() : raw;
  if (brief.length === 0) return { kind: 'ignored', reason: 'mention-only message' };

  const source: DiscordCommandSource = {
    kind: 'discord',
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    userLabel: message.author.username ?? message.author.id,
  };

  await controlPlane.postCommand({
    type: 'sprint_goal',
    goal: brief,
    repo: route.repo,
    source,
    // Idempotency: a duplicate Discord message (network retry / bot restart
    // re-delivery) will hash to the same key and the unified store will
    // dedup via the UNIQUE idempotency_key index.
    idempotencyKey: `discord:${message.channelId}:${message.id}`,
  });

  return { kind: 'posted', commandType: 'sprint_goal' };
}
