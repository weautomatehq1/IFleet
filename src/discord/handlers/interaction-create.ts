import {
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { ChannelRouter } from '../../contracts/channel-router.js';
import type {
  ControlCommand,
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';
import { parseCustomId, type DiscordCustomIdVerb } from '../../contracts/discord-out.js';
import { ControlPlaneError } from '../hmac-client.js';

export interface InteractionDeps {
  router: ChannelRouter;
  controlPlane: ControlPlaneClient;
  log?: (msg: string) => void;
}

export async function handleInteractionCreate(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, deps);
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction, deps);
    return;
  }
}

/**
 * Defer the interaction reply, tolerating a Discord gateway reconnect that
 * replays the same interaction. A replayed event arrives as a *new* object
 * with `deferred`/`replied` still false, so the property guard alone cannot
 * catch it — only the API rejection (40060) reveals the double-acknowledge.
 * Returns true when this delivery should proceed, false when it was already
 * handled or the interaction token expired and it must be abandoned.
 */
async function safeDeferReply(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return false;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    if (
      err instanceof DiscordAPIError &&
      (err.code === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged ||
        err.code === RESTJSONErrorCodes.UnknownInteraction)
    ) {
      return false;
    }
    throw err;
  }
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  deps: InteractionDeps,
): Promise<void> {
  // Discord 3s window — defer first, do work after. A WS reconnect can replay
  // the same interaction; safeDeferReply absorbs the resulting double-ack and
  // signals whether this delivery should proceed.
  if (!(await safeDeferReply(interaction))) return;

  const route = deps.router.resolve(interaction.channelId);
  if (!route) {
    await interaction.editReply(
      `This channel isn't mapped to any repo. Ask Sebastian to add it to config/channels.json.`,
    );
    return;
  }
  if (!route.allowedUserIds.includes(interaction.user.id)) {
    await interaction.editReply(`You are not on the allowedUserIds list for \`${route.repo}\`.`);
    return;
  }

  const source: DiscordCommandSource = {
    kind: 'discord',
    channelId: interaction.channelId,
    userId: interaction.user.id,
    userLabel: interaction.user.username,
  };

  const command = buildCommandFromSlash(interaction, route.repo, source);
  if (!command) {
    await interaction.editReply(`Unknown command \`${interaction.commandName}\`.`);
    return;
  }

  // Idempotency: include a key derived from the channel + interaction id so
  // a slash-command double-tap is collapsed server-side into one task.
  command.idempotencyKey = `discord:${interaction.channelId}:${interaction.id}`;

  try {
    const ack = await deps.controlPlane.postCommand(command);
    await interaction.editReply(formatAckReply(command, ack));
  } catch (err) {
    await interaction.editReply(formatErrorReply(err));
  }
}

async function handleButton(
  interaction: ButtonInteraction,
  deps: InteractionDeps,
): Promise<void> {
  // Defer first so a WS reconnect replay can't crash on a double-acknowledge,
  // same as the slash path. Every response below uses editReply.
  if (!(await safeDeferReply(interaction))) return;

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.editReply(`Unrecognised button \`${interaction.customId}\`.`);
    return;
  }

  // Deny on missing route. The previous form short-circuited when `route` was
  // null (DM or unmapped channel), so any guild member could approve/reject/
  // cancel any task by guessing its taskId. Treat unmapped channels as
  // hostile and require an explicit allowlist hit.
  const route = deps.router.resolve(interaction.channelId);
  if (!route || !route.allowedUserIds.includes(interaction.user.id)) {
    await interaction.editReply(`You are not authorised for this action.`);
    return;
  }

  const source: DiscordCommandSource = {
    kind: 'discord',
    channelId: interaction.channelId,
    userId: interaction.user.id,
    userLabel: interaction.user.username,
  };

  const command: ControlCommand = buildCommandFromButton(parsed.verb, parsed.taskId, source);
  command.idempotencyKey = `discord:${interaction.channelId}:${interaction.id}`;

  try {
    await deps.controlPlane.postCommand(command);
    await interaction.editReply(`✔ ${parsed.verb} dispatched for \`${parsed.taskId}\`.`);
  } catch (err) {
    await interaction.editReply(formatErrorReply(err));
  }
}

export function buildCommandFromButton(
  verb: DiscordCustomIdVerb,
  taskId: string,
  source: DiscordCommandSource,
): ControlCommand {
  if (verb === 'approve') return { type: 'approve', taskId, source };
  if (verb === 'verify_retry') return { type: 'verify', taskId, source };
  if (verb === 'verify_force_pr') {
    return { type: 'force_pr', taskId, reason: 'force-pr via discord (verifier failed)', source };
  }
  // Remaining verbs (reject, cancel, verify_cancel) all map to cancel.
  const reason =
    verb === 'reject'
      ? 'rejected via discord'
      : verb === 'verify_cancel'
        ? 'verifier cancelled via discord'
        : 'cancelled via discord';
  return { type: 'cancel', taskId, reason, source };
}

export function buildCommandFromSlash(
  interaction: ChatInputCommandInteraction,
  repo: string,
  source: DiscordCommandSource,
): ControlCommand | null {
  switch (interaction.commandName) {
    case 'ship': {
      const goal = interaction.options.getString('prompt', true);
      return { type: 'sprint_goal', goal, repo, source };
    }
    case 'plan': {
      const goal = interaction.options.getString('prompt', true);
      return { type: 'sprint_goal', goal, repo, planOnly: true, source };
    }
    case 'status': {
      const taskId = interaction.options.getString('taskid');
      if (taskId) return { type: 'status', taskId, source };
      // No taskId — server interprets a sentinel as "last 5 in this channel".
      return { type: 'status', taskId: `__channel__:${interaction.channelId}`, source };
    }
    case 'cancel': {
      const taskId = interaction.options.getString('taskid', true);
      return { type: 'cancel', taskId, reason: 'cancelled via discord', source };
    }
    case 'approve': {
      const taskId = interaction.options.getString('taskid', true);
      return { type: 'approve', taskId, source };
    }
    case 'audit':
      return { type: 'audit_scan', source };
    case 'audit-fix':
      return { type: 'audit_fix', source };
    case 'audit-autopilot':
      return { type: 'audit_autopilot', source };
    case 'audit-status':
      return { type: 'audit_status', source };
    default:
      return null;
  }
}

function formatAckReply(
  command: ControlCommand,
  ack: { accepted: boolean; taskId?: string; threadId?: string; message?: string },
): string {
  if (!ack.accepted) {
    return `❌ Control plane rejected \`${command.type}\`${ack.message ? `: ${ack.message}` : ''}`;
  }
  switch (command.type) {
    case 'sprint_goal': {
      const planSuffix = command.planOnly ? ' (plan-only)' : '';
      const thread = ack.threadId ? ` Thread: <#${ack.threadId}>` : '';
      const tid = ack.taskId ? ` Task: \`${ack.taskId}\`.` : '';
      return `✔ Queued${planSuffix}.${tid}${thread}`;
    }
    case 'status':
      return ack.message ? `\`\`\`\n${ack.message.slice(0, 1800)}\n\`\`\`` : `✔ Status requested.`;
    case 'cancel':
      return `✔ Cancel dispatched for \`${command.taskId}\`.`;
    case 'approve':
      return `✔ Approval dispatched for \`${command.taskId}\`.`;
    case 'run':
      return `✔ Run dispatched.`;
    default:
      return `✔ ok`;
  }
}

function formatErrorReply(err: unknown): string {
  if (err instanceof ControlPlaneError) {
    return `❌ Control plane error (${err.status}): ${err.responseBody || 'no body'}`;
  }
  if (err instanceof Error) return `❌ ${err.message}`;
  return `❌ unknown error`;
}
