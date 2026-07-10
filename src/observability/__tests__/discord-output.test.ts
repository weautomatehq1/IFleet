import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import {
  buildCustomId,
  DISCORD_CUSTOM_ID_VERBS,
  parseCustomId,
} from '@wahq/orchestrator-core/contracts/discord-out';
import type { ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import type { QueuedTask } from '@wahq/orchestrator-core/contracts/task';
import {
  chunkMessage,
  DISCORD_MESSAGE_LIMIT,
  DiscordOutAdapter,
  PLAN_ATTACHMENT_THRESHOLD,
  shortTitle,
  truncate,
} from '../discord-output.js';

const ALLSTATE_CHANNEL = '1503769258981589012';

function makeRouter(routes: Array<{ channelId: string; repo: string }>): ChannelRouter {
  const full = routes.map((r) => ({
    channelId: r.channelId,
    repo: r.repo,
    workDir: `/tmp/${r.repo.replace('/', '-')}`,
    defaultBranch: 'main',
    defaultModel: 'sonnet' as const,
    allowedUserIds: [],
    codeowners: [],
  }));
  return {
    resolve: (channelId) => full.find((r) => r.channelId === channelId) ?? null,
    list: () => full,
  };
}

function githubTask(over: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: '01HXTASK000',
    source: {
      kind: 'github',
      repo: 'weautomatehq1/allstate',
      issueNumber: 42,
      issueNodeId: 'I_kw',
      url: 'https://github.com/weautomatehq1/allstate/issues/42',
    },
    repo: 'weautomatehq1/allstate',
    brief: 'Add login page',
    title: 'Add login page',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: 1,
    idempotencyKey: 'k',
    ...over,
  };
}

function discordTask(over: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: '01HXTASK001',
    source: {
      kind: 'discord',
      channelId: ALLSTATE_CHANNEL,
      messageId: '1503769258981589013',
      userId: 'U999',
      userLabel: 'Sebas',
    },
    repo: 'weautomatehq1/allstate',
    brief: '/ship add login page',
    title: 'add login page',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: 1,
    idempotencyKey: 'k',
    ...over,
  };
}

/** Build a discord.js Client double exposing only what the adapter uses. */
function mockClient(): {
  client: Client;
  channelSend: ReturnType<typeof vi.fn>;
  threadSend: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  messagesFetch: ReturnType<typeof vi.fn>;
} {
  const threadSend = vi.fn().mockImplementation(async (_payload) => ({ id: 'M_NEW' }));
  const startThread = vi
    .fn()
    .mockImplementation(async (_opts: { name: string }) => ({
      id: 'T_NEW',
      send: threadSend,
    }));
  const channelSend = vi.fn().mockImplementation(async (_payload) => ({
    id: 'M_ANCHOR',
    startThread,
  }));
  const messagesFetch = vi.fn().mockImplementation(async (id: string) => ({
    id,
    startThread,
  }));

  const channels = {
    fetch: vi.fn().mockImplementation(async (id: string) => {
      if (id === 'T_NEW') {
        return { id: 'T_NEW', send: threadSend, isTextBased: (): boolean => true };
      }
      return {
        id,
        send: channelSend,
        messages: { fetch: messagesFetch },
        isTextBased: (): boolean => true,
      };
    }),
  };

  const client = { channels } as unknown as Client;
  return { client, channelSend, threadSend, startThread, messagesFetch };
}

describe('customId codec', () => {
  it('builds and parses round-trip for every verb', () => {
    for (const verb of DISCORD_CUSTOM_ID_VERBS) {
      const id = buildCustomId(verb, '01HXTASK000');
      expect(id).toBe(`${verb}:01HXTASK000`);
      expect(parseCustomId(id)).toEqual({ verb, taskId: '01HXTASK000' });
    }
  });

  it('rejects malformed input', () => {
    expect(parseCustomId('approve')).toBeNull();
    expect(parseCustomId('approve:')).toBeNull();
    expect(parseCustomId(':taskid')).toBeNull();
    expect(parseCustomId('explode:t1')).toBeNull();
  });

  it('preserves taskIds that contain colons', () => {
    // ULIDs don't but be defensive about future ID formats.
    const id = buildCustomId('cancel', 'a:b:c');
    expect(parseCustomId(id)).toEqual({ verb: 'cancel', taskId: 'a:b:c' });
  });
});

describe('chunkMessage', () => {
  it('returns input unchanged when under limit', () => {
    expect(chunkMessage('hello', 10)).toEqual(['hello']);
  });

  it('splits oversized messages under the limit, every chunk', () => {
    const text = ('x'.repeat(500) + '\n').repeat(10);
    const chunks = chunkMessage(text, 600);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    // Join roughly reconstructs (newlines may be eaten at split points).
    expect(chunks.join('').replace(/\n/g, '').length).toBeGreaterThan(text.length * 0.95);
  });

  it('prefers to split on newlines near the boundary', () => {
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50);
    const chunks = chunkMessage(text, 60);
    expect(chunks[0]).toBe('a'.repeat(50));
    expect(chunks[1]).toBe('b'.repeat(50));
  });

  it('hard-splits a single huge line', () => {
    const big = 'z'.repeat(5000);
    const chunks = chunkMessage(big, DISCORD_MESSAGE_LIMIT);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    expect(chunks.join('')).toBe(big);
  });
});

describe('shortTitle / truncate', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('compresses whitespace and caps thread name length', () => {
    const long = 'word '.repeat(40);
    const out = shortTitle(githubTask({ title: long, brief: 'b' }));
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out).not.toMatch(/  /);
  });
});

describe('DiscordOutAdapter.postTaskCreated', () => {
  it('opens a thread under the originating message for Discord-sourced tasks', async () => {
    const { client, messagesFetch, startThread } = mockClient();
    const adapter = new DiscordOutAdapter({
      client,
      router: makeRouter([]),
    });
    const { threadId } = await adapter.postTaskCreated(discordTask());
    expect(threadId).toBe('T_NEW');
    expect(messagesFetch).toHaveBeenCalledWith('1503769258981589013');
    expect(startThread).toHaveBeenCalledTimes(1);
  });

  it('opens an anchor message + thread in the repo-mapped channel for GitHub-sourced tasks', async () => {
    const { client, channelSend, startThread } = mockClient();
    const adapter = new DiscordOutAdapter({
      client,
      router: makeRouter([{ channelId: ALLSTATE_CHANNEL, repo: 'weautomatehq1/allstate' }]),
    });
    const { threadId } = await adapter.postTaskCreated(githubTask());
    expect(threadId).toBe('T_NEW');
    expect(channelSend).toHaveBeenCalledTimes(1);
    const payload = channelSend.mock.calls[0]?.[0] as { embeds: unknown[] };
    expect(payload.embeds).toBeDefined();
    expect(startThread).toHaveBeenCalledTimes(1);
  });

  it('falls back to DISCORD_FALLBACK_CHANNEL_ID when no route is found', async () => {
    const { client, channelSend, startThread } = mockClient();
    const adapter = new DiscordOutAdapter({
      client,
      router: makeRouter([]),
      fallbackChannelId: '999999999999',
    });
    const { threadId } = await adapter.postTaskCreated(githubTask());
    expect(threadId).toBe('T_NEW');
    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(startThread).toHaveBeenCalledTimes(1);
  });

  it('logs + returns empty threadId when no route and no fallback exist', async () => {
    const log = vi.fn();
    const { client, channelSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]), log });
    const { threadId } = await adapter.postTaskCreated(githubTask());
    expect(threadId).toBe('');
    expect(channelSend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('no channel route'));
  });

  it('does not throw if discord.js fetch rejects — orchestrator must stay alive', async () => {
    const log = vi.fn();
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error('discord down')) },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({
      client,
      router: makeRouter([{ channelId: ALLSTATE_CHANNEL, repo: 'weautomatehq1/allstate' }]),
      log,
    });
    const { threadId } = await adapter.postTaskCreated(githubTask());
    expect(threadId).toBe('');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('postTaskCreated failed'));
  });
});

describe('F2: postTaskCreated survives a thread that already exists', () => {
  const EXISTING_MSG = '1503769258981589013'; // discordTask().source.messageId

  it('reuses the existing thread when startThread fails (WS reconnect replay)', async () => {
    const log = vi.fn();
    const startThread = vi.fn(async () => {
      throw new Error('A thread has already been created for this message');
    });
    const channelsFetch = vi.fn(async (id: string) => {
      // A thread started from a message shares the message's snowflake id.
      if (id === EXISTING_MSG) return { id: EXISTING_MSG, isThread: () => true, isTextBased: (): boolean => true };
      // The parent text channel — origin.thread is null (empty cache).
      return {
        id,
        messages: { fetch: async (mid: string) => ({ id: mid, thread: null, startThread }) },
        isTextBased: (): boolean => true,
      };
    });
    const client = { channels: { fetch: channelsFetch } } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]), log });

    const { threadId } = await adapter.postTaskCreated(discordTask());

    expect(threadId).toBe(EXISTING_MSG);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('logs + returns empty threadId when startThread fails and no thread resolves', async () => {
    const log = vi.fn();
    const startThread = vi.fn(async () => {
      throw new Error('unexpected discord failure');
    });
    const channelsFetch = vi.fn(async (id: string) => {
      if (id === EXISTING_MSG) throw new Error('Unknown Channel');
      return {
        id,
        messages: { fetch: async (mid: string) => ({ id: mid, thread: null, startThread }) },
        isTextBased: (): boolean => true,
      };
    });
    const client = { channels: { fetch: channelsFetch } } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]), log });

    const { threadId } = await adapter.postTaskCreated(discordTask());

    expect(threadId).toBe('');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('postTaskCreated failed'));
  });
});

describe('DiscordOutAdapter.postProgress', () => {
  it('chunks long progress messages across multiple sends', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    const huge = 'x'.repeat(DISCORD_MESSAGE_LIMIT * 3 + 100);
    await adapter.postProgress('T_NEW', huge);
    expect(threadSend.mock.calls.length).toBeGreaterThan(1);
    for (const call of threadSend.mock.calls) {
      const arg = call[0] as string;
      expect(typeof arg).toBe('string');
      expect(arg.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('is a no-op for an empty threadId', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postProgress('', 'whatever');
    expect(threadSend).not.toHaveBeenCalled();
  });

  it('swallows fetch errors', async () => {
    const log = vi.fn();
    const client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error('410 gone')) },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]), log });
    await expect(adapter.postProgress('T_X', 'hi')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('postProgress failed'));
  });
});

describe('DiscordOutAdapter.postPlanForApproval', () => {
  it('posts an embed + three buttons with verb:taskRef customIds', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    const { messageId } = await adapter.postPlanForApproval('T_NEW', 'short plan');
    expect(messageId).toBe('M_NEW');

    const payload = threadSend.mock.calls[0]?.[0] as {
      components: Array<{ components: Array<{ data: { custom_id: string } }> }>;
    };
    const buttons = payload.components[0]!.components;
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.data.custom_id).toMatch(/^approve:/);
    expect(buttons[1]!.data.custom_id).toMatch(/^reject:/);
    expect(buttons[2]!.data.custom_id).toMatch(/^cancel:/);
  });

  it('attaches the plan as a file when it exceeds the threshold', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    const huge = 'x'.repeat(PLAN_ATTACHMENT_THRESHOLD + 1000);
    await adapter.postPlanForApproval('T_NEW', huge);
    const payload = threadSend.mock.calls[0]?.[0] as { files?: unknown[] };
    expect(payload.files).toBeDefined();
    expect(payload.files).toHaveLength(1);
  });

  it('does not attach a file for plans under the threshold', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postPlanForApproval('T_NEW', 'small');
    const payload = threadSend.mock.calls[0]?.[0] as { files?: unknown[] };
    expect(payload.files).toBeUndefined();
  });
});

describe('DiscordOutAdapter.postCompleted / postFailed', () => {
  it('sends a green embed with the PR URL on completion', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postCompleted('T_NEW', 'https://github.com/owner/repo/pull/123');
    const payload = threadSend.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]!.data.description).toContain('pull/123');
  });

  it('sends a red embed with the reason on failure', async () => {
    const { client, threadSend } = mockClient();
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postFailed('T_NEW', 'editor exited with code 2');
    const payload = threadSend.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]!.data.description).toContain('exited');
  });
});

describe('DiscordOutAdapter.postChannelMessage', () => {
  it('calls the channel send() method with the message', async () => {
    const send = vi.fn();
    const channel = { isTextBased: () => true, send };
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postChannelMessage('123', 'test message');
    expect(send).toHaveBeenCalledWith('test message');
  });

  it('is a no-op when the message is empty', async () => {
    const send = vi.fn();
    const channel = { isTextBased: () => true, send };
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postChannelMessage('123', '');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends with exact text when message is under truncation limit (AUDIT-IFleet-c75895ce)', async () => {
    // Regression guard: postChannelMessage passes the message through chunkMessage
    // which splits at DISCORD_MESSAGE_LIMIT. Messages under the limit must arrive
    // verbatim — this test pins the exact call so a future truncation regression
    // is detectable without reading the implementation.
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = { isTextBased: () => true, send };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    await adapter.postChannelMessage('123', 'test message');
    expect(send).toHaveBeenCalledWith('test message');
  });

  it('truncates a long postChannelMessage to DISCORD_MESSAGE_LIMIT (AUDIT-IFleet-c75895ce)', async () => {
    // postChannelMessage uses truncate() — sends a single message at most
    // DISCORD_MESSAGE_LIMIT chars. This pins the truncation behavior so a
    // future refactor that accidentally removes it is detectable.
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = { isTextBased: () => true, send };
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    const adapter = new DiscordOutAdapter({ client, router: makeRouter([]) });
    const huge = 'x'.repeat(DISCORD_MESSAGE_LIMIT + 500);
    await adapter.postChannelMessage('123', huge);
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0]![0] as string;
    expect(sent.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    // Content starts with original chars (truncation, not garbling)
    expect(huge.startsWith(sent.replace(/…$/, ''))).toBe(true);
  });
});
