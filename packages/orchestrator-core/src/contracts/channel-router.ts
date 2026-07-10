// Channel → repo lookup contract — T4 owns, T1/T2 consume.

export interface ChannelRoute {
  channelId: string;
  repo: string;
  workDir: string;
  defaultBranch: string;
  defaultModel: 'opus' | 'sonnet' | 'haiku';
  allowedUserIds: string[];
  codeowners: string[];
}

export interface ChannelRouter {
  resolve(channelId: string): ChannelRoute | null;
  list(): ChannelRoute[];
}
