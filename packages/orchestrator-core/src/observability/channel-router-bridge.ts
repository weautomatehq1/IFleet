// Thin adapter — given a QueuedTask, locate the destination channel for the
// initial thread post. T4 owns the ChannelRouter contract; this module is the
// glue between T5's output adapter and T4's data.

import type { ChannelRoute, ChannelRouter } from '../contracts/channel-router.js';
import type { QueuedTask } from '../contracts/task.js';

export type ChannelResolution =
  | {
      kind: 'discord-thread-anchor';
      channelId: string;
      messageId: string;
    }
  | {
      kind: 'channel-only';
      channelId: string;
      route: ChannelRoute | null;
    };

/**
 * Where should the thread for this task be opened?
 *
 * - Discord-sourced tasks: open the thread under the originating user message,
 *   so the user sees their `/ship` command and the thread side-by-side.
 * - GitHub-sourced tasks: open in the channel mapped to the repo by T4's
 *   router. If no route exists, fall back to {@link fallbackChannelId}.
 */
export function resolveTaskChannel(
  task: QueuedTask,
  router: ChannelRouter,
  fallbackChannelId: string | undefined,
): ChannelResolution | null {
  if (task.source.kind === 'discord') {
    // Slash commands have no messageId — fall back to channel-only routing
    // so the thread anchors under a fresh embed in the same channel rather
    // than trying to start a thread under a non-existent message. Same path
    // for HTTP control-plane tasks: their messageId is a ULID, not a Discord
    // snowflake; `messages.fetch(<ulid>)` returns "Invalid Form Body" from
    // Discord's API.
    if (task.source.messageId && isDiscordSnowflake(task.source.messageId)) {
      return {
        kind: 'discord-thread-anchor',
        channelId: task.source.channelId,
        messageId: task.source.messageId,
      };
    }
    const route = router.resolve(task.source.channelId);
    return { kind: 'channel-only', channelId: task.source.channelId, route: route ?? null };
  }
  const route = router.list().find((r) => r.repo === task.repo) ?? null;
  if (route) {
    return { kind: 'channel-only', channelId: route.channelId, route };
  }
  if (fallbackChannelId) {
    return { kind: 'channel-only', channelId: fallbackChannelId, route: null };
  }
  return null;
}

/** Discord snowflakes are 17–20 decimal digits. ULIDs (used by the HTTP
 * control-plane as task IDs) are 26 base32 chars and fail this check. */
export function isDiscordSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}
