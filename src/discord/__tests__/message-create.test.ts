import { describe, expect, it, vi } from 'vitest';
import { handleMessageCreate } from '@wahq/orchestrator-core/discord/handlers/message-create';
import type { ChannelRoute, ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import type {
  ControlCommand,
  ControlPlaneAck,
  ControlPlaneClient,
} from '../../contracts/control-plane-client.js';

const ALLOWED_USER = '111';
const BOT_ID = '999';
const ALLSTATE = '1503769258981589012';

function makeRoute(overrides: Partial<ChannelRoute> = {}): ChannelRoute {
  return {
    channelId: ALLSTATE,
    repo: 'weautomatehq1/allstate',
    workDir: '/opt/ifleet/repos/weautomatehq1-allstate',
    defaultBranch: 'main',
    defaultModel: 'sonnet',
    allowedUserIds: [ALLOWED_USER],
    codeowners: ['sebastianpuig'],
    ...overrides,
  };
}

function makeRouter(route: ChannelRoute | null): ChannelRouter {
  return {
    resolve: (id) => (id === route?.channelId ? route : null),
    list: () => (route ? [route] : []),
  };
}

function makeControlPlane(): {
  client: ControlPlaneClient;
  posts: ControlCommand[];
} {
  const posts: ControlCommand[] = [];
  return {
    posts,
    client: {
      async postCommand(cmd: ControlCommand): Promise<ControlPlaneAck> {
        posts.push(cmd);
        return { accepted: true, taskId: 'TASK_1' };
      },
    },
  };
}

interface MakeMsgOpts {
  content: string;
  authorId?: string;
  bot?: boolean;
  channelId?: string;
}
function makeMessage(opts: MakeMsgOpts): any {
  return {
    id: 'M1',
    channelId: opts.channelId ?? ALLSTATE,
    content: opts.content,
    author: {
      id: opts.authorId ?? ALLOWED_USER,
      bot: opts.bot ?? false,
      username: 'seb',
    },
  };
}

describe('handleMessageCreate', () => {
  const deps = (router: ChannelRouter, client: ControlPlaneClient, log = vi.fn()) => ({
    router,
    controlPlane: client,
    client: { user: { id: BOT_ID } as any },
    log,
  });

  it('ignores bot authors', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: 'hi', bot: true }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'ignored', reason: 'bot author' });
    expect(cp.posts).toHaveLength(0);
  });

  it('ignores unmapped channels', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: 'hi', channelId: '0000' }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome.kind).toBe('ignored');
    expect(cp.posts).toHaveLength(0);
  });

  it('silently ignores users not in allowedUserIds', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: 'hi', authorId: 'attacker' }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'ignored', reason: 'user not allowed' });
    expect(cp.posts).toHaveLength(0);
  });

  it('ignores !! debug prefix', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: '!! debug me' }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'ignored', reason: 'debug prefix' });
  });

  it('strips bot mention and POSTs sprint_goal', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: `<@${BOT_ID}> add login page` }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'posted', commandType: 'sprint_goal' });
    expect(cp.posts).toHaveLength(1);
    const cmd = cp.posts[0]!;
    expect(cmd.type).toBe('sprint_goal');
    if (cmd.type === 'sprint_goal') {
      expect(cmd.goal).toBe('add login page');
      expect(cmd.repo).toBe('weautomatehq1/allstate');
      expect(cmd.source?.kind).toBe('discord');
      expect(cmd.source?.userId).toBe(ALLOWED_USER);
    }
  });

  it('ignores mention-only messages with no body', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: `<@${BOT_ID}>` }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'ignored', reason: 'mention-only message' });
  });

  it('treats raw message as sprint_goal when no mention', async () => {
    const cp = makeControlPlane();
    const outcome = await handleMessageCreate(
      makeMessage({ content: 'rebuild the homepage' }),
      deps(makeRouter(makeRoute()), cp.client),
    );
    expect(outcome).toEqual({ kind: 'posted', commandType: 'sprint_goal' });
    expect(cp.posts[0]).toMatchObject({
      type: 'sprint_goal',
      goal: 'rebuild the homepage',
      repo: 'weautomatehq1/allstate',
    });
  });
});
