import {
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { ChannelRoute, ChannelRouter } from '../../contracts/channel-router.js';
import type {
  ControlCommand,
  ControlPlaneAck,
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';
import { parseCustomId, type DiscordCustomIdVerb } from '../../contracts/discord-out.js';
import { ControlPlaneError } from '../hmac-client.js';
import {
  formatFindingsList,
  markFindingsFixing,
  openFindings,
  readAuditIndex,
  resolveAuditIndexPath,
  setFindingsStatus,
  synthesizeAuditBrief,
  type AuditIndex,
} from '../audit-runner.js';
import {
  dbReadIndex,
  dbUpdateFindingStatus,
  normaliseAuditRepo,
} from '../../audit/audit-store.js';

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

  // Audit commands are handled inline against `.audits/index.json` via
  // `audit-runner.ts`; they never reach the control plane. `/audit-fix` is
  // multi-shaped (list / one / auto), `/audit-status` is read-only, and
  // `/audit-autopilot` is `/audit-fix auto` with no target arg. `/audit`
  // (scan) is intentionally a no-op — scans run from the Claude Code CLI.
  if (interaction.commandName === 'audit-fix') {
    await handleAuditFix(interaction, route, source, deps);
    return;
  }
  if (interaction.commandName === 'audit-status') {
    await handleAuditStatus(interaction, route);
    return;
  }
  if (interaction.commandName === 'audit') {
    await interaction.editReply(
      'Audit scans run from the Claude Code CLI (`/audit-scan`). ' +
        'Once findings land in `.audits/index.json`, use `/audit-fix` to dispatch them.',
    );
    return;
  }
  if (interaction.commandName === 'audit-autopilot') {
    await handleAuditFix(interaction, route, source, deps, { forceAuto: true });
    return;
  }

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

async function handleAuditStatus(
  interaction: ChatInputCommandInteraction,
  route: ChannelRoute,
): Promise<void> {
  const index = await loadAuditIndex(route.repo, route.workDir);
  if (!index) {
    await interaction.editReply('No audit findings yet — run `/audit-scan` from the CLI.');
    return;
  }
  const open = openFindings(index);
  const sev = index.by_severity ?? {};
  const lines = [
    `**Audit status** — ${index.repo || 'repo'}`,
    `Open: ${open.length}`,
    `• CRITICAL: ${sev['CRITICAL'] ?? 0}`,
    `• IMPORTANT: ${sev['IMPORTANT'] ?? 0}`,
    `• COSMETIC: ${sev['COSMETIC'] ?? 0}`,
    `Last scan: ${index.last_updated || '(unknown)'}`,
  ];
  await interaction.editReply(lines.join('\n'));
}

/**
 * Read the audit index, preferring Supabase (so VPS and Mac stay in sync)
 * and falling back to the local file when the DB is unreachable or empty.
 * Returns null when neither source has findings.
 *
 * `fullRepo` may be qualified (`weautomatehq1/IFleet`) or bare (`IFleet`).
 * Both forms are normalised inside `dbReadIndex` via `normaliseAuditRepo`,
 * so callers don't have to think about which they're holding.
 */
async function loadAuditIndex(fullRepo: string, repoRoot?: string): Promise<AuditIndex | null> {
  try {
    const dbIndex = await dbReadIndex(normaliseAuditRepo(fullRepo));
    if (dbIndex && dbIndex.findings.length > 0) return dbIndex;
  } catch (err) {
    console.warn(
      `[audit] dbReadIndex failed for ${fullRepo}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Use the per-channel route's workDir so e.g. an /audit-fix from the
  // #factory channel reads factory's .audits/index.json, not IFleet's.
  return readAuditIndex(resolveAuditIndexPath(repoRoot));
}

/**
 * Handle `/audit-fix`. Three modes, distinguished by the `target` option:
 *  - empty / `list` — read `.audits/index.json` and reply with open findings;
 *    no control-plane call.
 *  - `auto` — dispatch every open finding as its own `sprint_goal`.
 *  - `<finding id>` — dispatch that one finding.
 *
 * Findings are marked `fixing` before dispatch so a crash mid-loop does not
 * lose the intent; any that fail to queue are reverted to `open`.
 *
 * `opts.forceAuto` lets `/audit-autopilot` reuse this dispatch path without
 * exposing the `target` option in its slash-command schema.
 */
async function handleAuditFix(
  interaction: ChatInputCommandInteraction,
  route: ChannelRoute,
  source: DiscordCommandSource,
  deps: InteractionDeps,
  opts: { forceAuto?: boolean } = {},
): Promise<void> {
  // This read drives target selection only; markFindingsFixing / markFindingClosed
  // each re-read before mutating. Safe under the single-process IFleet daemon
  // (the only other writer, /audit-scan, is a separate CLI invoked by hand).
  // Read prefers Supabase (synced from Mac via `pnpm audit:sync`) so the VPS
  // sees the current findings even when its local index.json is stale.
  const indexPath = resolveAuditIndexPath(route.workDir);
  const index = await loadAuditIndex(route.repo, route.workDir);
  if (!index) {
    await interaction.editReply('No audit findings yet. Run /audit-scan first.');
    return;
  }

  const rawArg = opts.forceAuto
    ? 'auto'
    : interaction.options.getString('target')?.trim() ?? '';
  const lowerArg = rawArg.toLowerCase();

  // List mode — read-only.
  if (rawArg === '' || lowerArg === 'list') {
    await interaction.editReply(formatFindingsList(index));
    return;
  }

  const auto = lowerArg === 'auto';
  const targets = auto
    ? openFindings(index)
    : index.findings.filter((f) => f.id === rawArg);

  if (auto && targets.length === 0) {
    await interaction.editReply('No open audit findings to fix.');
    return;
  }
  if (!auto && targets.length === 0) {
    await interaction.editReply(
      `No finding with id \`${rawArg}\`. Run \`/audit-fix\` to list open findings.`,
    );
    return;
  }
  if (
    !auto &&
    targets[0] &&
    targets[0].status !== 'open' &&
    targets[0].status !== 'reopened'
  ) {
    await interaction.editReply(
      `Finding \`${rawArg}\` is \`${targets[0].status}\`, not open — nothing to dispatch.`,
    );
    return;
  }

  // Mark fixing BEFORE dispatch (intent survives a mid-loop crash). Update
  // both the local file and Supabase so the two stores don't drift; Supabase
  // failures are logged but don't block dispatch (the local file is the
  // canonical source for the pipeline runner's close-out).
  markFindingsFixing(
    indexPath,
    targets.map((f) => f.id),
  );
  for (const finding of targets) {
    try {
      await dbUpdateFindingStatus(finding.id, 'fixing');
    } catch (err) {
      console.error(
        `[audit-sync] dbUpdateFindingStatus(fixing) failed for ${finding.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const queued: string[] = [];
  const failed: string[] = [];
  let lastAck: ControlPlaneAck | undefined;
  for (const finding of targets) {
    const command: ControlCommand = {
      type: 'sprint_goal',
      goal: synthesizeAuditBrief(finding),
      repo: route.repo,
      source,
    };
    // Per-finding idempotency key so the control plane does not collapse the
    // auto-mode batch (one interaction id, many commands) into a single task.
    command.idempotencyKey = `discord:${interaction.channelId}:${interaction.id}:${finding.id}`;
    try {
      const ack = await deps.controlPlane.postCommand(command);
      if (ack.accepted) {
        queued.push(finding.id);
        lastAck = ack;
      } else {
        failed.push(finding.id);
      }
    } catch (err) {
      console.warn(
        `[audit-fix] postCommand failed for finding ${finding.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failed.push(finding.id);
    }
  }

  // Revert anything that failed to queue so it stays visible to /audit-fix.
  if (failed.length > 0) {
    setFindingsStatus(indexPath, failed, 'open');
    for (const id of failed) {
      try {
        await dbUpdateFindingStatus(id, 'open');
      } catch (err) {
        console.error(
          `[audit-sync] dbUpdateFindingStatus(open) failed for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  await interaction.editReply(formatAuditFixReply(auto, rawArg, queued, failed, lastAck));
}

function formatAuditFixReply(
  auto: boolean,
  rawArg: string,
  queued: string[],
  failed: string[],
  lastAck: ControlPlaneAck | undefined,
): string {
  if (auto) {
    if (queued.length === 0) {
      return `❌ Failed to queue all ${failed.length} findings — left open. Try again.`;
    }
    let reply = `Queued ${queued.length} findings. IFleet will open one PR per finding — check back in #ifleet.`;
    if (failed.length > 0) {
      reply += `\n⚠ ${failed.length} failed to queue and were left open.`;
    }
    return reply;
  }
  if (queued.length === 1) {
    const task = lastAck?.taskId ? ` Task: \`${lastAck.taskId}\`.` : '';
    const thread = lastAck?.threadId ? ` Thread: <#${lastAck.threadId}>` : '';
    return `✔ Queued fix for \`${queued[0]}\`.${task}${thread}`;
  }
  return `❌ Failed to queue fix for \`${rawArg}\` — left open. Try again.`;
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
      const explicit = interaction.options.getString('taskid');
      // No taskid → server resolves the newest in-flight task in this channel
      // via the `__channel_current__:` sentinel. Same pattern as /status.
      const taskId = explicit ?? `__channel_current__:${interaction.channelId}`;
      return { type: 'cancel', taskId, reason: 'cancelled via discord', source };
    }
    case 'pause': {
      const reason = interaction.options.getString('reason') ?? undefined;
      const cmd: ControlCommand = { type: 'pause', source };
      if (reason) cmd.reason = reason;
      return cmd;
    }
    case 'continue': {
      return { type: 'continue', source };
    }
    case 'stop': {
      const reason = interaction.options.getString('reason') ?? undefined;
      const cmd: ControlCommand = { type: 'stop', source };
      if (reason) cmd.reason = reason;
      return cmd;
    }
    case 'approve': {
      const taskId = interaction.options.getString('taskid', true);
      return { type: 'approve', taskId, source };
    }
    case 'verify': {
      const taskId = interaction.options.getString('taskid', true);
      return { type: 'verify', taskId, source };
    }
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
    case 'verify':
      return `✔ Verifier rerun dispatched for \`${command.taskId}\`.`;
    case 'force_pr':
      return `✔ Force-PR dispatched for \`${command.taskId}\`.`;
    case 'run':
      return `✔ Run dispatched.`;
    case 'pause':
      return `⏸ Fleet pause dispatched${command.reason ? ` — ${command.reason}` : ''}.`;
    case 'continue':
      return `▶ Fleet continue dispatched.`;
    case 'stop':
      return `🛑 Fleet STOP dispatched${command.reason ? ` — ${command.reason}` : ''}. All in-flight tasks cancelling; queue paused.`;
    default:
      return `✔ ok`;
  }
}

function formatErrorReply(err: unknown): string {
  if (err instanceof ControlPlaneError) {
    const body = (err.responseBody || 'no body').slice(0, 200);
    return `❌ Control plane error (${err.status}): ${body}`;
  }
  if (err instanceof Error) return `❌ ${err.message}`;
  return `❌ unknown error`;
}
