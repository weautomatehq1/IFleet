// Unified QueuedTask contract — T2 owns, T1/T4/T5 read.
// See ~/.omc/splits/20260516-1430-ifleet-discord-rebuild/MASTER.md §"Shared contracts".

import type { RoutingHints } from '../queue/types.js';

export type TaskState = 'pending' | 'in_flight' | 'done' | 'failed' | 'blocked';

export type TaskSource =
  | {
      kind: 'github';
      repo: string;
      issueNumber: number;
      issueNodeId: string;
      url: string;
    }
  | {
      kind: 'discord';
      channelId: string;
      messageId: string;
      threadId?: string;
      userId: string;
      userLabel: string;
    };

export interface QueuedTask {
  id: string;
  source: TaskSource;
  repo: string;
  brief: string;
  title: string;
  routingHints: RoutingHints;
  createdAt: number;
  idempotencyKey: string;
  state?: TaskState;
  stateMeta?: Record<string, unknown>;
}

export function isDiscordSource(s: TaskSource): s is Extract<TaskSource, { kind: 'discord' }> {
  return s.kind === 'discord';
}

export function isGitHubSource(s: TaskSource): s is Extract<TaskSource, { kind: 'github' }> {
  return s.kind === 'github';
}
