import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import {
  buildCommandFromButton,
  buildCommandFromSlash,
  handleInteractionCreate,
} from '../handlers/interaction-create.js';
import {
  DISCORD_CUSTOM_ID_MAX,
  parseCustomId,
  buildCustomId,
} from '../../contracts/discord-out.js';
import type {
  ControlCommand,
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';
import type { ChannelRouter } from '../../contracts/channel-router.js';

const ALLSTATE = '1503769258981589012';
const SOURCE: DiscordCommandSource = {
  kind: 'discord',
  channelId: ALLSTATE,
  userId: '111',
  userLabel: 'seb',
};

function makeSlash(name: string, opts: Record<string, string | null>): any {
  return {
    channelId: ALLSTATE,
    commandName: name,
    options: {
      getString: vi.fn((key: string, required?: boolean) => {
        const v = opts[key];
        if (v === undefined && required) throw new Error(`missing ${key}`);
        if (v === undefined) return null;
        return v;
      }),
    },
    user: { id: '111', username: 'seb' },
  };
}

describe('buildCommandFromSlash', () => {
  it('builds sprint_goal from /ship', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('ship', { prompt: 'add login page' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'sprint_goal',
      goal: 'add login page',
      repo: 'weautomatehq1/allstate',
      source: SOURCE,
    });
  });

  it('tags /plan as planOnly', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('plan', { prompt: 'design X' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toMatchObject({ type: 'sprint_goal', planOnly: true });
  });

  it('falls back to channel sentinel for /status without taskid', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('status', { taskid: null }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'status',
      taskId: `__channel__:${ALLSTATE}`,
      source: SOURCE,
    });
  });

  it('builds /cancel with reason', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('cancel', { taskid: 'T1' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'cancelled via discord',
      source: SOURCE,
    });
  });

  it('builds /approve', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('approve', { taskid: 'T1' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({ type: 'approve', taskId: 'T1', source: SOURCE });
  });

  it('returns null on unknown command', () => {
    const cmd = buildCommandFromSlash(makeSlash('bogus', {}), 'r', SOURCE);
    expect(cmd).toBeNull();
  });
});

describe('button customId round-trip (T5 contract)', () => {
  it('parses approve:<taskId>', () => {
    expect(parseCustomId(buildCustomId('approve', 'TASK_1'))).toEqual({
      verb: 'approve',
      taskId: 'TASK_1',
    });
  });

  it('parses reject:<taskId>', () => {
    expect(parseCustomId('reject:abc-123')).toEqual({ verb: 'reject', taskId: 'abc-123' });
  });

  it('returns null on unknown verb', () => {
    expect(parseCustomId('zap:T1')).toBeNull();
  });

  it('returns null on missing taskId', () => {
    expect(parseCustomId('approve:')).toBeNull();
    expect(parseCustomId('approve')).toBeNull();
  });

  it('preserves task ids containing colons', () => {
    expect(parseCustomId('cancel:project:42')).toEqual({
      verb: 'cancel',
      taskId: 'project:42',
    });
  });
});

describe('HIGH-6: buildCustomId length guard', () => {
  it('round-trips short taskIds (ULID range)', () => {
    const id = buildCustomId('approve', '01HXYZABCDEFG');
    expect(id.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX);
  });

  it('throws on taskIds that would push the customId past 100 chars', () => {
    const huge = 'x'.repeat(120);
    expect(() => buildCustomId('approve', huge)).toThrow(/exceeds 100/);
  });
});

describe('CRIT-2: handleInteractionCreate authz on unmapped channels', () => {
  function makeRouter(mappedChannel: string | null): ChannelRouter {
    return {
      resolve: (channelId: string) =>
        channelId === mappedChannel
          ? {
              channelId,
              repo: 'weautomatehq1/allstate',
              defaultBranch: 'main',
              defaultModel: 'opus',
              allowedUserIds: ['SOMEONE_ELSE'],
              codeowners: [],
              workDir: '/tmp/r',
            }
          : null,
      list: () => [],
    };
  }

  function makeControlPlane(): ControlPlaneClient & { posted: ControlCommand[] } {
    const posted: ControlCommand[] = [];
    return {
      posted,
      postCommand: async (cmd) => {
        posted.push(cmd);
        return { accepted: true };
      },
    };
  }

  function makeButtonInteraction(channelId: string, customId: string): any {
    const editReply = vi.fn();
    return {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId,
      channelId,
      user: { id: '111', username: 'attacker' },
      deferReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      editReply,
    };
  }

  it('denies a button click in a DM / unmapped channel even with a valid customId', async () => {
    const router = makeRouter('CHAN_MAPPED');
    const controlPlane = makeControlPlane();
    const customId = buildCustomId('approve', 'T1');
    const interaction = makeButtonInteraction('CHAN_UNMAPPED', customId);

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/not authorised/i),
    );
    expect(controlPlane.posted).toHaveLength(0);
  });

  it('denies a button click from a user not on the allowedUserIds list', async () => {
    const router = makeRouter('CHAN_MAPPED');
    const controlPlane = makeControlPlane();
    const interaction = makeButtonInteraction('CHAN_MAPPED', 'approve:T1');

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(controlPlane.posted).toHaveLength(0);
  });
});

describe('F1: slash command survives WS reconnect replay (error 40060)', () => {
  function okRouter(): ChannelRouter {
    return {
      resolve: (channelId: string) =>
        channelId === ALLSTATE
          ? {
              channelId,
              repo: 'weautomatehq1/allstate',
              defaultBranch: 'main',
              defaultModel: 'opus',
              allowedUserIds: ['111'],
              codeowners: [],
              workDir: '/tmp/r',
            }
          : null,
      list: () => [],
    };
  }

  function spyControlPlane(): ControlPlaneClient & { posted: ControlCommand[] } {
    const posted: ControlCommand[] = [];
    return {
      posted,
      postCommand: async (cmd) => {
        posted.push(cmd);
        return { accepted: true };
      },
    };
  }

  function discordError(code: number, message: string): DiscordAPIError {
    return new DiscordAPIError({ code, message }, code, code >= 50000 ? 403 : 400, 'POST', 'https://discord.test', {
      body: {},
      files: [],
    });
  }

  function makeSlashInteraction(over: Record<string, unknown> = {}): any {
    return {
      isChatInputCommand: () => true,
      isButton: () => false,
      id: 'INTERACTION_1',
      channelId: ALLSTATE,
      commandName: 'ship',
      options: { getString: vi.fn(() => 'add a thing') },
      user: { id: '111', username: 'seb' },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      ...over,
    };
  }

  it('swallows error 40060 from deferReply and does not dispatch', async () => {
    const interaction = makeSlashInteraction({
      deferReply: vi.fn(async () => {
        throw discordError(40060, 'Interaction has already been acknowledged.');
      }),
    });
    const controlPlane = spyControlPlane();

    await expect(
      handleInteractionCreate(interaction, { router: okRouter(), controlPlane }),
    ).resolves.toBeUndefined();
    expect(controlPlane.posted).toHaveLength(0);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('swallows error 10062 (unknown interaction — token expired) from deferReply', async () => {
    const interaction = makeSlashInteraction({
      deferReply: vi.fn(async () => {
        throw discordError(10062, 'Unknown interaction');
      }),
    });
    const controlPlane = spyControlPlane();

    await expect(
      handleInteractionCreate(interaction, { router: okRouter(), controlPlane }),
    ).resolves.toBeUndefined();
    expect(controlPlane.posted).toHaveLength(0);
  });

  it('skips a same-object replay where deferred is already true', async () => {
    const interaction = makeSlashInteraction({ deferred: true });
    const controlPlane = spyControlPlane();

    await handleInteractionCreate(interaction, { router: okRouter(), controlPlane });

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(controlPlane.posted).toHaveLength(0);
  });

  it('rethrows a non-ignorable Discord API error', async () => {
    const err = discordError(50001, 'Missing Access');
    const interaction = makeSlashInteraction({
      deferReply: vi.fn(async () => {
        throw err;
      }),
    });

    await expect(
      handleInteractionCreate(interaction, { router: okRouter(), controlPlane: spyControlPlane() }),
    ).rejects.toBe(err);
  });

  it('swallows error 40060 on a replayed button interaction', async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'approve:T1',
      channelId: ALLSTATE,
      user: { id: '111', username: 'seb' },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        throw discordError(40060, 'Interaction has already been acknowledged.');
      }),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    } as any;
    const controlPlane = spyControlPlane();

    await expect(
      handleInteractionCreate(interaction, { router: okRouter(), controlPlane }),
    ).resolves.toBeUndefined();
    expect(controlPlane.posted).toHaveLength(0);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('dispatches normally when deferReply succeeds', async () => {
    const interaction = makeSlashInteraction();
    const controlPlane = spyControlPlane();

    await handleInteractionCreate(interaction, { router: okRouter(), controlPlane });

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(controlPlane.posted).toHaveLength(1);
    expect(controlPlane.posted[0]).toMatchObject({ type: 'sprint_goal' });
  });
});

describe('buildCommandFromButton', () => {
  it('maps approve verb to approve command', () => {
    expect(buildCommandFromButton('approve', 'T1', SOURCE)).toEqual({
      type: 'approve',
      taskId: 'T1',
      source: SOURCE,
    });
  });

  it('maps reject verb to cancel with reject reason', () => {
    expect(buildCommandFromButton('reject', 'T1', SOURCE)).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'rejected via discord',
      source: SOURCE,
    });
  });

  it('maps cancel verb to cancel with cancel reason', () => {
    expect(buildCommandFromButton('cancel', 'T1', SOURCE)).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'cancelled via discord',
      source: SOURCE,
    });
  });
});
