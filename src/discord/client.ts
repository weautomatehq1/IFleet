import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import type { ChannelRouter } from '../contracts/channel-router.js';
import type { ControlPlaneClient } from '../contracts/control-plane-client.js';
import { handleInteractionCreate } from './handlers/interaction-create.js';
import { handleMessageCreate } from './handlers/message-create.js';
import { handleReactionAdd, type ReactionDeps } from './handlers/reaction-add.js';

export interface DiscordClientDeps {
  router: ChannelRouter;
  controlPlane: ControlPlaneClient;
  /** Provided by T5's DiscordOut adapter; nullable so tests/dev can stub. */
  resolveTaskIdFromMessage?: ReactionDeps['resolveTaskIdFromMessage'];
  log?: (msg: string) => void;
}

export function createDiscordClient(deps: DiscordClientDeps): Client {
  const log = deps.log ?? ((m) => console.warn(m));
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    log(`[discord] logged in as ${c.user.tag}`);
    log(`[discord] mapped channels: ${deps.router.list().map((r) => `${r.channelId}→${r.repo}`).join(', ') || '(none)'}`);
  });

  client.on(Events.MessageCreate, (message: Message) => {
    void handleMessageCreate(message, {
      router: deps.router,
      controlPlane: deps.controlPlane,
      client,
      log,
    }).catch((err) => log(`[discord] messageCreate error: ${stringify(err)}`));
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void handleInteractionCreate(interaction, {
      router: deps.router,
      controlPlane: deps.controlPlane,
      log,
    }).catch((err) => log(`[discord] interactionCreate error: ${stringify(err)}`));
  });

  const resolveTaskIdFromMessage =
    deps.resolveTaskIdFromMessage ?? (async () => null);
  client.on(
    Events.MessageReactionAdd,
    (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      void handleReactionAdd(reaction, user, {
        router: deps.router,
        controlPlane: deps.controlPlane,
        resolveTaskIdFromMessage,
        log,
      }).catch((err) => log(`[discord] reactionAdd error: ${stringify(err)}`));
    },
  );

  return client;
}

function stringify(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
