import { describe, expect, it, vi } from 'vitest';
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
