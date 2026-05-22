// DiscordOut adapter — posts task lifecycle to Discord using discord.js.
// See src/contracts/discord-out.ts for the contract + customId format.

import type { Client, TextChannel, ThreadChannel, Message } from 'discord.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import type { ChannelRouter } from '../contracts/channel-router.js';
import {
  buildCustomId,
  type DiscordOut,
} from '../contracts/discord-out.js';
import type { QueuedTask } from '../contracts/task.js';
import { resolveTaskChannel } from './channel-router-bridge.js';

export const DISCORD_MESSAGE_LIMIT = 1900; // 2000 hard cap; leave headroom
export const DISCORD_EMBED_DESC_LIMIT = 4000; // 4096 hard cap
export const PLAN_ATTACHMENT_THRESHOLD = 3800; // post as file beyond this

const THREAD_NAME_LIMIT = 90; // Discord allows 100; leave headroom

/** Status badge emoji set used in progress messages. */
export const STATUS_BADGE = {
  picked: '🟡',
  building: '🔵',
  done: '🟢',
  failed: '🔴',
  cancelled: '🛑',
  paused: '⏸',
} as const;

export interface DiscordOutAdapterOpts {
  client: Client;
  router: ChannelRouter;
  /** Channel ID used when no route is found for a GitHub-sourced task. */
  fallbackChannelId?: string;
  /** Custom logger — defaults to console.warn for failures. */
  log?: (level: 'warn' | 'info', message: string) => void;
}

/**
 * DiscordOut implementation.
 *
 * Failures are caught and logged — never thrown — so the orchestrator event
 * loop is never broken by a transient Discord outage.
 */
export class DiscordOutAdapter implements DiscordOut {
  private readonly client: Client;
  private readonly router: ChannelRouter;
  private readonly fallbackChannelId: string | undefined;
  private readonly log: (level: 'warn' | 'info', message: string) => void;
  /** threadId → taskId so postPlanForApproval can emit `<verb>:<taskId>` customIds. */
  private readonly threadTaskIndex = new Map<string, string>();

  constructor(opts: DiscordOutAdapterOpts) {
    this.client = opts.client;
    this.router = opts.router;
    this.fallbackChannelId = opts.fallbackChannelId;
    this.log =
      opts.log ??
      ((level, message) => {
        // eslint-disable-next-line no-console
        (level === 'warn' ? console.warn : console.info)(`[discord-out] ${message}`);
      });
  }

  /**
   * Bind a pre-existing thread (e.g. Discord-sourced task with
   * `source.threadId` already set) to its taskId so subsequent
   * postPlanForApproval calls can emit `<verb>:<taskId>` customIds.
   */
  bindThreadToTask(threadId: string, taskId: string): void {
    if (threadId && taskId) this.threadTaskIndex.set(threadId, taskId);
  }

  async postTaskCreated(task: QueuedTask): Promise<{ threadId: string }> {
    const route = resolveTaskChannel(task, this.router, this.fallbackChannelId);
    if (!route) {
      this.log('warn', `no channel route for task ${task.id} (repo=${task.repo}) — dropping`);
      return { threadId: '' };
    }

    try {
      if (route.kind === 'discord-thread-anchor') {
        const ch = (await this.client.channels.fetch(route.channelId)) as TextChannel | null;
        if (!ch) throw new Error(`channel ${route.channelId} not fetchable`);
        const origin = (await ch.messages.fetch(route.messageId)) as Message;
        // Fast path: thread already in the client cache.
        if (origin.thread) {
          this.threadTaskIndex.set(origin.thread.id, task.id);
          return { threadId: origin.thread.id };
        }
        try {
          const thread = await origin.startThread({
            name: shortTitle(task),
            autoArchiveDuration: 1440,
          });
          this.threadTaskIndex.set(thread.id, task.id);
          return { threadId: thread.id };
        } catch (err) {
          // The thread exists server-side but was absent from the cache (the
          // common case after a daemon restart, where `origin.thread` is null)
          // or a duplicate delivery raced us. A thread started from a message
          // shares that message's snowflake id — resolve it directly so the
          // duplicate reuses the existing thread instead of failing.
          const existing = await this.resolveThreadById(route.messageId);
          if (existing) {
            this.threadTaskIndex.set(existing, task.id);
            return { threadId: existing };
          }
          throw err;
        }
      }

      const ch = (await this.client.channels.fetch(route.channelId)) as TextChannel | null;
      if (!ch) throw new Error(`channel ${route.channelId} not fetchable`);
      const anchor = await ch.send({ embeds: [taskEmbed(task)] });
      const thread = await anchor.startThread({
        name: shortTitle(task),
        autoArchiveDuration: 1440,
      });
      this.threadTaskIndex.set(thread.id, task.id);
      return { threadId: thread.id };
    } catch (err) {
      this.log('warn', `postTaskCreated failed for ${task.id}: ${errMsg(err)}`);
      return { threadId: '' };
    }
  }

  /**
   * Resolve a thread channel by its snowflake id. A thread started from a
   * message shares that message's id, so this doubles as "does this message
   * already have a thread?" without depending on the client cache. Returns
   * the thread id, or null when no thread exists there / Discord is down.
   */
  private async resolveThreadById(threadId: string): Promise<string | null> {
    try {
      const ch = await this.client.channels.fetch(threadId);
      if (ch?.isThread()) return ch.id;
    } catch {
      // No thread at that id, or Discord unreachable — caller falls through.
    }
    return null;
  }

  async postProgress(threadId: string, message: string): Promise<void> {
    if (!threadId) return;
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread) throw new Error(`thread ${threadId} not fetchable`);
      for (const chunk of chunkMessage(message, DISCORD_MESSAGE_LIMIT)) {
        await thread.send(chunk);
      }
    } catch (err) {
      this.log('warn', `postProgress failed for thread ${threadId}: ${errMsg(err)}`);
    }
  }

  async postPlanForApproval(
    threadId: string,
    plan: string,
  ): Promise<{ messageId: string }> {
    if (!threadId) return { messageId: '' };
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread) throw new Error(`thread ${threadId} not fetchable`);

      // customId = `<verb>:<taskId>` per src/contracts/discord-out.ts.
      // The adapter memoizes threadId → taskId on postTaskCreated /
      // bindThreadToTask. Falls back to threadId when unknown so T1 can still
      // dispatch via a `store.list({channelId: threadId})` lookup.
      const taskRef = this.threadTaskIndex.get(threadId) ?? threadId;

      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('approve', taskRef))
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildCustomId('reject', taskRef))
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(buildCustomId('cancel', taskRef))
          .setLabel('Cancel task')
          .setStyle(ButtonStyle.Secondary),
      );

      const isOversize = plan.length > PLAN_ATTACHMENT_THRESHOLD;
      const embed = new EmbedBuilder()
        .setTitle('Architect plan — approve?')
        .setDescription(
          isOversize
            ? truncate(plan, 400) + '\n\n_Full plan attached as `plan.md`._'
            : truncate(plan, DISCORD_EMBED_DESC_LIMIT),
        );

      const payload: Parameters<ThreadChannel['send']>[0] = {
        embeds: [embed],
        components: [buttons],
      };
      if (isOversize) {
        payload.files = [
          new AttachmentBuilder(Buffer.from(plan, 'utf8'), { name: 'plan.md' }),
        ];
      }

      const msg = await thread.send(payload);
      return { messageId: msg.id };
    } catch (err) {
      this.log('warn', `postPlanForApproval failed for thread ${threadId}: ${errMsg(err)}`);
      return { messageId: '' };
    }
  }

  async postCompleted(threadId: string, prUrl: string): Promise<void> {
    if (!threadId) return;
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread) throw new Error(`thread ${threadId} not fetchable`);
      const embed = new EmbedBuilder()
        .setTitle(`${STATUS_BADGE.done} Completed`)
        .setDescription(
          prUrl === 'already-resolved'
            ? 'Already resolved — no changes needed. Finding closed.'
            : `Pull request opened.\n${prUrl}`,
        );
      await thread.send({ embeds: [embed] });
    } catch (err) {
      this.log('warn', `postCompleted failed for thread ${threadId}: ${errMsg(err)}`);
    }
  }

  async postFailed(threadId: string, reason: string): Promise<void> {
    if (!threadId) return;
    try {
      const thread = (await this.client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread) throw new Error(`thread ${threadId} not fetchable`);
      const embed = new EmbedBuilder()
        .setTitle(`${STATUS_BADGE.failed} Failed`)
        .setDescription(truncate(reason, DISCORD_EMBED_DESC_LIMIT));
      await thread.send({ embeds: [embed] });
    } catch (err) {
      this.log('warn', `postFailed failed for thread ${threadId}: ${errMsg(err)}`);
    }
  }

  async postChannelMessage(channelId: string, message: string): Promise<void> {
    if (!channelId) return;
    try {
      const channel = (await this.client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel) throw new Error(`channel ${channelId} not fetchable`);
      await channel.send(truncate(message, DISCORD_MESSAGE_LIMIT));
    } catch (err) {
      this.log('warn', `postChannelMessage failed for channel ${channelId}: ${errMsg(err)}`);
    }
  }
}

// ---- helpers (exported for tests) ----

export function chunkMessage(message: string, limit: number): string[] {
  if (message.length <= limit) return [message];
  const out: string[] = [];
  let remaining = message;
  while (remaining.length > limit) {
    // Prefer to split on a newline near the limit.
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function shortTitle(task: QueuedTask): string {
  const raw = task.title?.trim() || task.brief.slice(0, 80) || `task ${task.id}`;
  return truncate(raw.replace(/\s+/g, ' '), THREAD_NAME_LIMIT);
}

export function taskEmbed(task: QueuedTask): EmbedBuilder {
  const source =
    task.source.kind === 'github'
      ? `GitHub · ${task.source.repo}#${task.source.issueNumber}`
      : `Discord · <@${task.source.userId}>`;
  return new EmbedBuilder()
    .setTitle(`${STATUS_BADGE.picked} ${shortTitle(task)}`)
    .setDescription(truncate(task.brief, 1500))
    .addFields(
      { name: 'Source', value: source, inline: true },
      { name: 'Repo', value: task.repo, inline: true },
    );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
