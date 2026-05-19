// HMAC-signed POST client contract — T1 and T3 use, T2's server enforces.
// Wire format mirrors src/queue/control-plane.ts (signPayload + verifySignature).

export type ControlCommand =
  | {
      type: 'sprint_goal';
      goal: string;
      repo?: string;
      planOnly?: boolean;
      source?: DiscordCommandSource;
      /**
       * Idempotency key generated at the originating Discord client so the
       * control plane can dedup a double-tap of the same slash command or a
       * retried POST. Format: `discord:${channelId}:${messageId ?? interactionId}`.
       */
      idempotencyKey?: string;
    }
  | { type: 'run'; repo?: string; source?: DiscordCommandSource; idempotencyKey?: string }
  | { type: 'cancel'; taskId: string; reason?: string; source?: DiscordCommandSource; idempotencyKey?: string }
  | { type: 'status'; taskId: string; source?: DiscordCommandSource; idempotencyKey?: string }
  | { type: 'approve'; taskId: string; source?: DiscordCommandSource; idempotencyKey?: string }
  /**
   * Manual verifier rerun — Discord `/verify <taskId>` or the [Retry] button on
   * a verifier failure surface. Control plane re-invokes
   * VerifierController.verifyManual(taskId); attempt is the next available
   * slot (latest persisted attempt + 1).
   */
  | { type: 'verify'; taskId: string; source?: DiscordCommandSource; idempotencyKey?: string }
  /**
   * Force-open the PR despite verifier failures. Gated by `allowedUserIds`,
   * always logged as a deliberate override (verifier_runs.status stays
   * `failed`, but a `force_pr_at` audit row goes into events). Triggered by
   * the [Force-PR] button on a failure surface.
   */
  | { type: 'force_pr'; taskId: string; reason?: string; source?: DiscordCommandSource; idempotencyKey?: string };

export interface DiscordCommandSource {
  kind: 'discord';
  channelId: string;
  messageId?: string;
  userId: string;
  userLabel: string;
}

export interface ControlPlaneClient {
  postCommand(cmd: ControlCommand): Promise<ControlPlaneAck>;
}

export interface ControlPlaneAck {
  accepted: boolean;
  taskId?: string;
  threadId?: string;
  message?: string;
}
