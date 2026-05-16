// HMAC-signed POST client contract — T1 and T3 use, T2's server enforces.
// Wire format mirrors src/queue/control-plane.ts (signPayload + verifySignature).

export type ControlCommand =
  | {
      type: 'sprint_goal';
      goal: string;
      repo?: string;
      planOnly?: boolean;
      source?: DiscordCommandSource;
    }
  | { type: 'run'; repo?: string; source?: DiscordCommandSource }
  | { type: 'cancel'; taskId: string; reason?: string; source?: DiscordCommandSource }
  | { type: 'status'; taskId: string; source?: DiscordCommandSource }
  | { type: 'approve'; taskId: string; source?: DiscordCommandSource };

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
