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
  | { type: 'approve'; taskId: string; source?: DiscordCommandSource; idempotencyKey?: string };

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
