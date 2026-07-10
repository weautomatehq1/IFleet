import { describe, expect, it } from 'vitest';
import type { ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import type { QueuedTask } from '@wahq/orchestrator-core/contracts/task';
import {
  isDiscordSnowflake,
  resolveTaskChannel,
} from '../channel-router-bridge.js';

const CHANNEL = '1503769258981589012';

function discordTask(over: { messageId?: string } = {}): QueuedTask {
  return {
    id: '01HXTASK000',
    source: {
      kind: 'discord',
      channelId: CHANNEL,
      ...(over.messageId !== undefined ? { messageId: over.messageId } : {}),
      userId: 'U1',
      userLabel: 'Sebas',
    },
    repo: 'weautomatehq1/allstate',
    brief: 'b',
    title: 't',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: 1,
    idempotencyKey: 'k',
  };
}

const emptyRouter: ChannelRouter = { resolve: () => null, list: () => [] };

describe('isDiscordSnowflake', () => {
  it('accepts 17–20 digit numeric ids', () => {
    expect(isDiscordSnowflake('12345678901234567')).toBe(true); // 17
    expect(isDiscordSnowflake('1503769258981589012')).toBe(true); // 19
    expect(isDiscordSnowflake('12345678901234567890')).toBe(true); // 20
  });

  it('rejects ULIDs, short ids, and non-numeric strings', () => {
    expect(isDiscordSnowflake('01KS4VTEST000000001IFLEET')).toBe(false);
    expect(isDiscordSnowflake('12345')).toBe(false);
    expect(isDiscordSnowflake('123456789012345678901')).toBe(false); // 21
    expect(isDiscordSnowflake('abc')).toBe(false);
    expect(isDiscordSnowflake('')).toBe(false);
  });
});

describe('resolveTaskChannel — Discord source', () => {
  it('uses thread-anchor when messageId is a real snowflake', () => {
    const r = resolveTaskChannel(
      discordTask({ messageId: '1503769258981589012' }),
      emptyRouter,
      undefined,
    );
    expect(r?.kind).toBe('discord-thread-anchor');
  });

  it('falls through to channel-only when messageId is a non-snowflake (HTTP control-plane ULID)', () => {
    // Reproduces the pm2-log bug: "postTaskCreated failed: Invalid Form Body"
    // came from messages.fetch(<ULID>). The fix routes those to channel-only
    // so a fresh anchor message is created instead.
    const r = resolveTaskChannel(
      discordTask({ messageId: '01KS4VTEST000000001IFLEET' }),
      emptyRouter,
      undefined,
    );
    expect(r?.kind).toBe('channel-only');
    if (r?.kind === 'channel-only') {
      expect(r.channelId).toBe(CHANNEL);
    }
  });

  it('falls through to channel-only when messageId is absent (slash commands)', () => {
    const r = resolveTaskChannel(discordTask({}), emptyRouter, undefined);
    expect(r?.kind).toBe('channel-only');
  });
});
