// Output adapter contract — T5 owns, T1/T2 consume.

import type { QueuedTask } from './task.js';

/**
 * Adapter that posts task lifecycle messages to Discord.
 *
 * `postTaskCreated` is the only call that opens a thread; every other method
 * takes the returned `threadId` and posts inside that thread.
 *
 * Implementations MUST be tolerant of a missing channel/thread route — they
 * should fall back to a configured default (env `DISCORD_FALLBACK_CHANNEL_ID`)
 * or log + drop. Never throw in a way that breaks the orchestrator loop.
 */
export interface DiscordOut {
  postTaskCreated(task: QueuedTask): Promise<{ threadId: string }>;
  postProgress(threadId: string, message: string): Promise<void>;
  postPlanForApproval(threadId: string, plan: string): Promise<{ messageId: string }>;
  postCompleted(threadId: string, prUrl: string): Promise<void>;
  postFailed(threadId: string, reason: string): Promise<void>;
}

/**
 * Button customId format published by {@link DiscordOut.postPlanForApproval}.
 *
 * T1's `interactionCreate` handler parses these strings and dispatches back
 * to the ControlPlane. Format is `<verb>:<taskId>` — taskId is shorter than
 * the Discord threadId and lets T1 look up the task in O(1) via
 * `store.getById(taskId)`.
 *
 * | customId            | Meaning                              |
 * |---------------------|--------------------------------------|
 * | `approve:<taskId>`  | User approved the architect plan     |
 * | `reject:<taskId>`   | User rejected the plan (rework)      |
 * | `cancel:<taskId>`   | User cancelled the whole task        |
 */
export const DISCORD_CUSTOM_ID_VERBS = ['approve', 'reject', 'cancel'] as const;

export type DiscordCustomIdVerb = (typeof DISCORD_CUSTOM_ID_VERBS)[number];

export function buildCustomId(verb: DiscordCustomIdVerb, taskId: string): string {
  return `${verb}:${taskId}`;
}

export function parseCustomId(
  customId: string,
): { verb: DiscordCustomIdVerb; taskId: string } | null {
  const idx = customId.indexOf(':');
  if (idx <= 0) return null;
  const verb = customId.slice(0, idx);
  const taskId = customId.slice(idx + 1);
  if (!taskId) return null;
  if (verb !== 'approve' && verb !== 'reject' && verb !== 'cancel') return null;
  return { verb, taskId };
}
