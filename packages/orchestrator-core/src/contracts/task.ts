// Unified QueuedTask contract — T2 owns, T1/T4/T5 read.
// See ~/.omc/splits/20260516-1430-ifleet-discord-rebuild/MASTER.md §"Shared contracts".

import type { RoutingHints, SprintMode, RoutingDecision } from './routing.js';

export type { SprintMode };

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
      /** Optional — slash commands have only an interaction.id; dedup happens via idempotencyKey. */
      messageId?: string;
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
  /**
   * Per-task routing mode (`ralph` | `ulw` | `tdd` | `deslop` | `standard`).
   * Set by the classifier (`mode:*` label override or Haiku auto-router).
   * Pipeline consumers read this to pick the architect/editor prompt template.
   * `null` / undefined → use the standard prompt with no mode-specific routing.
   */
  mode?: SprintMode | null;
  /**
   * Per-task routing decision captured at dispatch time (M6 shadow-eval
   * substrate). NULL on rows persisted before the M6 migration — readers
   * MUST treat absence as "no routing recorded" rather than a default.
   */
  routingDecision?: RoutingDecision | null;
}

export function isDiscordSource(s: TaskSource): s is Extract<TaskSource, { kind: 'discord' }> {
  return s.kind === 'discord';
}

export function isGitHubSource(s: TaskSource): s is Extract<TaskSource, { kind: 'github' }> {
  return s.kind === 'github';
}
