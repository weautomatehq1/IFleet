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
  /**
   * Post a plain-text message directly to a channel (not a thread).
   * Used for channel-level pings (e.g. audit-fix completion summary).
   * Implementations must never throw — wrap in try/catch internally.
   */
  postChannelMessage(channelId: string, message: string): Promise<void>;
  /**
   * Optional. Bind a Discord-sourced task's existing thread to its taskId so
   * subsequent `postPlanForApproval` calls emit `<verb>:<taskId>` customIds
   * instead of falling back to the threadId. Implementations that route
   * everything via fresh threads (created in `postTaskCreated`) can omit it.
   */
  bindThreadToTask?(threadId: string, taskId: string): void;
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
export const DISCORD_CUSTOM_ID_VERBS = [
  'approve',
  'reject',
  'cancel',
  // Verifier failure surface buttons (M1.W3 — see docs/elevation/upgrades/01-verifier.md).
  'verify_retry',
  'verify_force_pr',
  'verify_cancel',
  // M5 Goal Proposer HITL buttons (docs/elevation/upgrades/06-goal-driven.md).
  // The `taskId` portion of the customId is the `goal_proposals.id` UUID,
  // not a queue task id — they route through `recordProposalDecision` in
  // `src/orchestrator/approval-gate.ts`, not the control-plane bridge.
  'proposal_approve',
  'proposal_reject',
  'proposal_defer',
] as const;

export type DiscordCustomIdVerb = (typeof DISCORD_CUSTOM_ID_VERBS)[number];

export const DISCORD_CUSTOM_ID_MAX = 100;

export function buildCustomId(verb: DiscordCustomIdVerb, taskId: string): string {
  const result = `${verb}:${taskId}`;
  if (result.length > DISCORD_CUSTOM_ID_MAX) {
    // Discord silently rejects the entire message send when customId > 100
    // chars, so the HITL approval button would vanish without any error
    // surfacing. ULID-derived taskIds (~26 chars) sit well under today's
    // limit but a future scheme switch (e.g. embedding repo + ULID) would
    // breach it invisibly — fail loud instead.
    throw new RangeError(
      `Discord customId exceeds ${DISCORD_CUSTOM_ID_MAX} chars: got ${result.length} (verb=${verb}, taskId=${taskId})`,
    );
  }
  return result;
}

export function parseCustomId(
  customId: string,
): { verb: DiscordCustomIdVerb; taskId: string } | null {
  const idx = customId.indexOf(':');
  if (idx <= 0) return null;
  const verb = customId.slice(0, idx);
  const taskId = customId.slice(idx + 1);
  if (!taskId) return null;
  if (!(DISCORD_CUSTOM_ID_VERBS as ReadonlyArray<string>).includes(verb)) return null;
  return { verb: verb as DiscordCustomIdVerb, taskId };
}
