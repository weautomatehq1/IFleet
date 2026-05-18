import { createHash } from 'node:crypto';
import type { ChannelRouter } from '../../contracts/channel-router.js';
import type { DiscordOut } from '../../contracts/discord-out.js';
import type { QueuedTask, TaskSource as TaskSourceType } from '../../contracts/task.js';
import type { RoutingHints } from '../types.js';
import { ulid } from '../../utils/ulid.js';
import type { TaskStore } from '../store.js';
import type { TaskSource } from './base.js';

export interface DiscordIngestCommand {
  goal: string;
  repo?: string;
  channelId: string;
  /** Optional — slash commands have only an interaction.id. Caller MUST
   * provide either `messageId` or `idempotencyKey` for dedup. */
  messageId?: string;
  userId: string;
  userLabel: string;
  idempotencyKey?: string;
  planOnly?: boolean;
}

export interface DiscordSourceOptions {
  router: ChannelRouter;
  out: DiscordOut;
  /** Default routing hints applied when the slash command does not override. */
  defaults?: Partial<RoutingHints>;
  /** Allow ingestion when no ChannelRoute matches. Default: false. */
  allowUnknownChannel?: boolean;
}

export class DiscordSource implements TaskSource {
  readonly kind = 'discord' as const;

  constructor(private readonly opts: DiscordSourceOptions) {}

  /** Discord pushes via ControlPlane callbacks — no polling. */
  async drain(_store: TaskStore): Promise<number> {
    return 0;
  }

  /**
   * Ingest a Discord-originated sprint goal. Resolves repo + routing via the
   * channel router, materializes the Discord thread, builds a QueuedTask and
   * inserts it into the store. Returns the task (existing if duplicate).
   */
  async ingest(cmd: DiscordIngestCommand, store: TaskStore): Promise<QueuedTask> {
    const route = this.opts.router.resolve(cmd.channelId);
    const repo = cmd.repo ?? route?.repo;
    if (!repo) {
      throw new Error(`channel ${cmd.channelId} has no route and no repo override`);
    }
    if (!route && !cmd.repo && !this.opts.allowUnknownChannel) {
      throw new Error(`no channel route for ${cmd.channelId}`);
    }

    let idempotencyKey = cmd.idempotencyKey;
    if (!idempotencyKey) {
      if (!cmd.messageId) {
        throw new Error('discord ingest requires either messageId or idempotencyKey');
      }
      idempotencyKey = idempotencyForDiscord(cmd.channelId, cmd.messageId);
    }

    const existing = store.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const source: TaskSourceType = {
      kind: 'discord',
      channelId: cmd.channelId,
      ...(cmd.messageId ? { messageId: cmd.messageId } : {}),
      userId: cmd.userId,
      userLabel: cmd.userLabel,
    };
    const createdAt = Date.now();
    const draftTask: QueuedTask = {
      id: ulid(createdAt),
      source,
      repo,
      brief: cmd.goal,
      title: deriveTitle(cmd.goal),
      routingHints: this.deriveHints(route?.defaultModel),
      createdAt,
      idempotencyKey,
      state: 'pending',
    };

    // Post the Discord thread BEFORE inserting so we can capture threadId.
    // If posting fails we still want to land the task — but mark it `blocked`
    // with a state_meta describing the failure so an operator can retry
    // rather than letting it ship as a zombie row that later `markPicked`
    // calls cannot route a Discord message to.
    let threadFailure: unknown;
    try {
      const { threadId } = await this.opts.out.postTaskCreated(draftTask);
      (draftTask.source as Extract<TaskSourceType, { kind: 'discord' }>).threadId = threadId;
    } catch (err) {
      threadFailure = err;
      console.warn('[discord-source] postTaskCreated failed:', err);
    }

    if (threadFailure !== undefined) {
      draftTask.state = 'blocked';
      draftTask.stateMeta = {
        reason: 'discord_thread_failed',
        error: threadFailure instanceof Error ? threadFailure.message : String(threadFailure),
      };
    }
    store.insert(draftTask);
    return draftTask;
  }

  async markPicked(task: QueuedTask): Promise<void> {
    const tid = threadIdOrThrow(task);
    await this.opts.out.postProgress(tid, '🤖 Picked up — worker starting.');
  }

  async markCompleted(task: QueuedTask, prUrl: string): Promise<void> {
    const tid = threadIdOrThrow(task);
    await this.opts.out.postCompleted(tid, prUrl);
  }

  async markFailed(task: QueuedTask, reason: string): Promise<void> {
    const tid = threadIdOrThrow(task);
    await this.opts.out.postFailed(tid, reason);
  }

  async markBlocked(task: QueuedTask, capability: string): Promise<void> {
    const tid = threadIdOrThrow(task);
    await this.opts.out.postFailed(tid, `Blocked — missing capability: ${capability}`);
  }

  private deriveHints(model?: 'opus' | 'sonnet' | 'haiku'): RoutingHints {
    return {
      model: model ?? this.opts.defaults?.model ?? 'opus',
      priority: this.opts.defaults?.priority ?? 'normal',
      verify: this.opts.defaults?.verify ?? ['typecheck', 'lint', 'test'],
      autonomy: this.opts.defaults?.autonomy ?? 'auto',
    };
  }
}

export function idempotencyForDiscord(channelId: string, messageId: string): string {
  return createHash('sha256').update(`discord:${channelId}:${messageId}`).digest('hex');
}

function deriveTitle(goal: string): string {
  const firstLine = goal.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine || 'Discord task';
}

function threadIdOrThrow(task: QueuedTask): string {
  if (task.source.kind !== 'discord') {
    throw new Error(`DiscordSource cannot mark a ${task.source.kind} task`);
  }
  const tid = task.source.threadId;
  if (!tid) throw new Error(`task ${task.id} has no Discord threadId`);
  return tid;
}
