import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import { recordProposalDecision } from '../../orchestrator/approval-gate.js';
import {
  buildCommandFromButton,
  buildCommandFromSlash,
  handleInteractionCreate,
} from '@wahq/orchestrator-core/discord/handlers/interaction-create';
import {
  DISCORD_CUSTOM_ID_MAX,
  parseCustomId,
  buildCustomId,
} from '@wahq/orchestrator-core/contracts/discord-out';
import type {
  ControlCommand,
  ControlPlaneClient,
  DiscordCommandSource,
} from '../../contracts/control-plane-client.js';
import type { ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';

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

describe('AUDIT-IFleet-f1164e07: /status reply carries real task fields', () => {
  function makeRouter(): ChannelRouter {
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

  it('formats a code-block reply when control plane returns a status message', async () => {
    const statusMessage = 'id: task-abc\nstate: in_flight\ntitle: add login page\nrepo: weautomatehq1/allstate';
    const controlPlane: ControlPlaneClient = {
      postCommand: async () => ({ accepted: true, message: statusMessage }),
    };
    const interaction: any = {
      isChatInputCommand: () => true,
      isButton: () => false,
      id: 'INTERACTION_STATUS',
      channelId: ALLSTATE,
      commandName: 'status',
      options: {
        getString: vi.fn((key: string) => (key === 'taskid' ? 'task-abc' : null)),
      },
      user: { id: '111', username: 'seb' },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    await handleInteractionCreate(interaction, { router: makeRouter(), controlPlane });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('task-abc'),
    );
    const reply: string = interaction.editReply.mock.calls[0][0];
    expect(reply.startsWith('```')).toBe(true);
  });

  it('falls back to "Status requested." when control plane returns no message', async () => {
    const controlPlane: ControlPlaneClient = {
      postCommand: async () => ({ accepted: true }),
    };
    const interaction: any = {
      isChatInputCommand: () => true,
      isButton: () => false,
      id: 'INTERACTION_STATUS_EMPTY',
      channelId: ALLSTATE,
      commandName: 'status',
      options: {
        getString: vi.fn((key: string) => (key === 'taskid' ? 'task-xyz' : null)),
      },
      user: { id: '111', username: 'seb' },
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    await handleInteractionCreate(interaction, { router: makeRouter(), controlPlane });

    expect(interaction.editReply).toHaveBeenCalledWith('✔ Status requested.');
  });
});

vi.mock('../../orchestrator/approval-gate.js', () => ({
  recordProposalDecision: vi.fn(async () => ({ updated: true })),
}));

const proposalStoreState: {
  getProposalForShip: ReturnType<typeof vi.fn>;
  setResultingTaskId: ReturnType<typeof vi.fn>;
} = {
  getProposalForShip: vi.fn(),
  setResultingTaskId: vi.fn(async () => ({ updated: true })),
};

vi.mock('../../orchestrator/goal-proposals-store.js', () => ({
  getProposalForShip: (...args: unknown[]) =>
    (proposalStoreState.getProposalForShip as (...a: unknown[]) => unknown)(...args),
  setResultingTaskId: (...args: unknown[]) =>
    (proposalStoreState.setResultingTaskId as (...a: unknown[]) => unknown)(...args),
}));

describe('M5 proposal buttons — IFLEET_PROPOSALS_CHANNEL_ID gating', () => {
  const PROPOSALS = '9999000099990000';
  const APPROVER = '111';

  function makeProposalRouter(): ChannelRouter {
    return {
      resolve: (channelId: string) =>
        channelId === '1503769258981589012'
          ? {
              channelId,
              repo: 'weautomatehq1/IFleet',
              defaultBranch: 'main',
              defaultModel: 'opus',
              allowedUserIds: [APPROVER],
              codeowners: [],
              workDir: '/tmp/r',
            }
          : null,
      list: () => [
        {
          channelId: '1503769258981589012',
          repo: 'weautomatehq1/IFleet',
          defaultBranch: 'main',
          defaultModel: 'opus',
          allowedUserIds: [APPROVER],
          codeowners: [],
          workDir: '/tmp/r',
        },
      ],
    };
  }

  function makeButton(channelId: string, customId: string, userId = APPROVER): any {
    return {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId,
      channelId,
      user: { id: userId, username: 'seb' },
      deferReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      editReply: vi.fn(),
    };
  }

  function makeCp(): ControlPlaneClient & { posted: ControlCommand[] } {
    const posted: ControlCommand[] = [];
    return { posted, postCommand: async (c) => { posted.push(c); return { accepted: true }; } };
  }

  const restoreEnv = () => {
    delete process.env['IFLEET_PROPOSALS_CHANNEL_ID'];
    delete process.env['IFLEET_PROPOSALS_APPROVER_IDS'];
  };

  it('denies proposal button when IFLEET_PROPOSALS_CHANNEL_ID is unset', async () => {
    restoreEnv();
    const interaction = makeButton(PROPOSALS, 'proposal_approve:p-1');
    await handleInteractionCreate(interaction, { router: makeProposalRouter(), controlPlane: makeCp() });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/not authorised/i));
  });

  it('denies proposal button when click happens outside the proposals channel', async () => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    const interaction = makeButton('1503769258981589012', 'proposal_approve:p-1');
    await handleInteractionCreate(interaction, { router: makeProposalRouter(), controlPlane: makeCp() });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/not authorised/i));
    restoreEnv();
  });

  it('accepts proposal button when channel id and approver id match (explicit approver list)', async () => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    process.env['IFLEET_PROPOSALS_APPROVER_IDS'] = '111';
    proposalStoreState.getProposalForShip = vi.fn(async () => ({
      id: 'p-1',
      repo_id: 'weautomatehq1/IFleet',
      title: 'Add reopen sweep',
      rationale: 'Reopened findings have no GC.',
    }));
    proposalStoreState.setResultingTaskId = vi.fn(async () => ({ updated: true }));
    const interaction = makeButton(PROPOSALS, 'proposal_approve:p-1');
    await handleInteractionCreate(interaction, { router: makeProposalRouter(), controlPlane: makeCp() });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/✔ Approved/));
    restoreEnv();
  });

  it('denies proposal button when IFLEET_PROPOSALS_APPROVER_IDS is unset', async () => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    delete process.env['IFLEET_PROPOSALS_APPROVER_IDS'];
    const interaction = makeButton(PROPOSALS, 'proposal_approve:p-1');
    await handleInteractionCreate(interaction, { router: makeProposalRouter(), controlPlane: makeCp() });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/not authorised/i));
    restoreEnv();
  });

  it('denies proposal button when explicit approver list rejects clicker', async () => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    process.env['IFLEET_PROPOSALS_APPROVER_IDS'] = '222,333';
    const interaction = makeButton(PROPOSALS, 'proposal_approve:p-1');
    await handleInteractionCreate(interaction, { router: makeProposalRouter(), controlPlane: makeCp() });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringMatching(/not authorised/i));
    restoreEnv();
  });
});

describe('M5.2-T1: Approve → /ship enqueue', () => {
  const PROPOSALS = '9999000099990000';
  const APPROVER = '111';


  function router(): ChannelRouter {
    return {
      resolve: () => null,
      list: () => [
        {
          channelId: '1503769258981589012',
          repo: 'weautomatehq1/IFleet',
          defaultBranch: 'main',
          defaultModel: 'opus',
          allowedUserIds: [APPROVER],
          codeowners: [],
          workDir: '/tmp/r',
        },
      ],
    };
  }

  function button(customId: string): any {
    return {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId,
      channelId: PROPOSALS,
      user: { id: APPROVER, username: 'seb' },
      deferReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      editReply: vi.fn(),
    };
  }

  function cp(opts: {
    accepted?: boolean;
    taskId?: string;
    message?: string;
    throws?: boolean;
  } = {}): ControlPlaneClient & { posted: ControlCommand[] } {
    const posted: ControlCommand[] = [];
    return {
      posted,
      postCommand: async (c) => {
        posted.push(c);
        if (opts.throws) throw new Error('control plane down');
        return {
          accepted: opts.accepted ?? true,
          taskId: opts.taskId ?? (opts.accepted === false ? undefined : 'task-xyz'),
          message: opts.message,
        };
      },
    };
  }

  beforeEach(() => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    process.env['IFLEET_PROPOSALS_APPROVER_IDS'] = APPROVER;
    proposalStoreState.getProposalForShip = vi.fn(async () => ({
      id: 'p-99',
      repo_id: 'weautomatehq1/IFleet',
      title: 'Add audit reopen sweep',
      rationale: 'r',
    }));
    proposalStoreState.setResultingTaskId = vi.fn(async () => ({ updated: true }));
  });

  afterEach(() => {
    delete process.env['IFLEET_PROPOSALS_CHANNEL_ID'];
    delete process.env['IFLEET_PROPOSALS_APPROVER_IDS'];
  });

  it('posts a sprint_goal ControlCommand and links the resulting task id on accept', async () => {
    const controlPlane = cp({ taskId: 'task-7' });
    const interaction = button('proposal_approve:p-99');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(controlPlane.posted).toHaveLength(1);
    const sent = controlPlane.posted[0]!;
    expect(sent.type).toBe('sprint_goal');
    if (sent.type === 'sprint_goal') {
      expect(sent.goal).toBe('Add audit reopen sweep');
      expect(sent.repo).toBe('weautomatehq1/IFleet');
      expect(sent.idempotencyKey).toBe('proposal:p-99');
    }
    expect(proposalStoreState.setResultingTaskId).toHaveBeenCalledWith('p-99', 'task-7');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/enqueued as `task-7`/),
    );
  });

  it('keeps the decision but reports a warning when the control plane refuses', async () => {
    const controlPlane = cp({ accepted: false, message: 'queue full' });
    const interaction = button('proposal_approve:p-99');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(controlPlane.posted).toHaveLength(1);
    expect(proposalStoreState.setResultingTaskId).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/control plane did not accept/),
    );
  });

  it('keeps the decision but reports a warning when the control plane throws', async () => {
    const controlPlane = cp({ throws: true });
    const interaction = button('proposal_approve:p-99');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(proposalStoreState.setResultingTaskId).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/control plane refused/),
    );
  });

  it('does NOT post a sprint_goal on Reject or Defer', async () => {
    const controlPlane = cp();
    const interaction = button('proposal_reject:p-99');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(controlPlane.posted).toHaveLength(0);
    expect(proposalStoreState.setResultingTaskId).not.toHaveBeenCalled();
  });

  it('reports proposal pruned when the row is missing at enqueue time', async () => {
    proposalStoreState.getProposalForShip = vi.fn(async () => null);
    const controlPlane = cp();
    const interaction = button('proposal_approve:p-99');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(controlPlane.posted).toHaveLength(0);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/proposal row was missing/),
    );
  });
});

describe('AUDIT-IFleet-50b49e86: first-write-wins guard — handler side', () => {
  const PROPOSALS = '9999000099990000';
  const APPROVER = '111';


  function router(): ChannelRouter {
    return {
      resolve: () => null,
      list: () => [
        {
          channelId: '1503769258981589012',
          repo: 'weautomatehq1/IFleet',
          defaultBranch: 'main',
          defaultModel: 'opus',
          allowedUserIds: [APPROVER],
          codeowners: [],
          workDir: '/tmp/r',
        },
      ],
    };
  }

  function button(customId: string): any {
    return {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId,
      channelId: PROPOSALS,
      user: { id: APPROVER, username: 'seb' },
      deferReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      editReply: vi.fn(),
    };
  }

  function cp(): ControlPlaneClient & { posted: ControlCommand[] } {
    const posted: ControlCommand[] = [];
    return { posted, postCommand: async (c) => { posted.push(c); return { accepted: true, taskId: 'task-xyz' }; } };
  }

  beforeEach(() => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = PROPOSALS;
    process.env['IFLEET_PROPOSALS_APPROVER_IDS'] = APPROVER;
    proposalStoreState.getProposalForShip = vi.fn(async () => ({
      id: 'p-dupe',
      repo_id: 'weautomatehq1/IFleet',
      title: 'Duplicate approve test',
      rationale: 'r',
    }));
    proposalStoreState.setResultingTaskId = vi.fn(async () => ({ updated: true }));
  });

  afterEach(() => {
    delete process.env['IFLEET_PROPOSALS_CHANNEL_ID'];
    delete process.env['IFLEET_PROPOSALS_APPROVER_IDS'];
    vi.mocked(recordProposalDecision).mockRestore();
  });

  it('proposal_approve on already-decided row replies "already decided" and does NOT call enqueueApprovedProposal', async () => {
    vi.mocked(recordProposalDecision).mockResolvedValueOnce({
      updated: false,
      existing_decision: 'approved',
    });
    const controlPlane = cp();
    const interaction = button('proposal_approve:p-dupe');
    await handleInteractionCreate(interaction, { router: router(), controlPlane });

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/already decided/i),
    );
    expect(controlPlane.posted).toHaveLength(0);
    expect(proposalStoreState.setResultingTaskId).not.toHaveBeenCalled();
  });
});
