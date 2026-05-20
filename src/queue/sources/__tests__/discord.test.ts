import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { TaskStore } from '../../store.js';
import { DiscordSource, idempotencyForDiscord } from '../discord.js';
import type { ChannelRouter, ChannelRoute } from '../../../contracts/channel-router.js';
import type { DiscordOut } from '../../../contracts/discord-out.js';
import type { QueuedTask } from '../../../contracts/task.js';

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-disc-'));
  const store = new TaskStore(join(dir, 'tasks.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function mockRouter(route: ChannelRoute | null): ChannelRouter {
  return { resolve: () => route, list: () => (route ? [route] : []) };
}

function mockOut(): { out: DiscordOut; calls: string[]; threadId: string } {
  const calls: string[] = [];
  const threadId = 'thr-123';
  const out: DiscordOut = {
    postTaskCreated: async (task: QueuedTask) => {
      calls.push(`created:${task.id}`);
      return { threadId };
    },
    postProgress: async (tid, msg) => {
      calls.push(`progress:${tid}:${msg}`);
    },
    postPlanForApproval: async (tid) => {
      calls.push(`plan:${tid}`);
      return { messageId: 'm-1' };
    },
    postCompleted: async (tid, pr) => {
      calls.push(`done:${tid}:${pr}`);
    },
    postFailed: async (tid, reason) => {
      calls.push(`fail:${tid}:${reason}`);
    },
  };
  return { out, calls, threadId };
}

const ROUTE: ChannelRoute = {
  channelId: '1503769258981589012',
  repo: 'weautomatehq1/Allstate',
  workDir: '/opt/ifleet/repos/weautomatehq1-Allstate',
  defaultBranch: 'main',
  defaultModel: 'opus',
  allowedUserIds: [],
  codeowners: [],
};

describe('DiscordSource.ingest', () => {
  it('resolves repo via router and posts thread before insert', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const { out, calls, threadId } = mockOut();
      const src = new DiscordSource({ router: mockRouter(ROUTE), out });
      const task = await src.ingest(
        {
          goal: 'add login page',
          channelId: ROUTE.channelId,
          messageId: 'm-1',
          userId: 'u-1',
          userLabel: 'Sebas',
        },
        store,
      );
      assert.equal(task.repo, ROUTE.repo);
      assert.equal(task.source.kind, 'discord');
      if (task.source.kind === 'discord') {
        assert.equal(task.source.threadId, threadId);
      }
      assert.ok(calls.some((c) => c.startsWith('created:')));
      assert.equal(store.count(), 1);
    } finally {
      cleanup();
    }
  });

  it('dedups by idempotencyKey across redeliveries', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const { out } = mockOut();
      const src = new DiscordSource({ router: mockRouter(ROUTE), out });
      const cmd = {
        goal: 'X',
        channelId: ROUTE.channelId,
        messageId: 'same',
        userId: 'u-1',
        userLabel: 'Sebas',
      };
      const a = await src.ingest(cmd, store);
      const b = await src.ingest(cmd, store);
      assert.equal(a.id, b.id);
      assert.equal(store.count(), 1);
    } finally {
      cleanup();
    }
  });

  it('throws when no route and override repo not provided', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const { out } = mockOut();
      const src = new DiscordSource({ router: mockRouter(null), out });
      await assert.rejects(() =>
        src.ingest(
          {
            goal: 'X',
            channelId: 'unknown',
            messageId: 'm',
            userId: 'u',
            userLabel: 'Sebas',
          },
          store,
        ),
      );
    } finally {
      cleanup();
    }
  });

  it('idempotencyForDiscord is deterministic', () => {
    assert.equal(idempotencyForDiscord('c', 'm'), idempotencyForDiscord('c', 'm'));
    assert.notEqual(idempotencyForDiscord('c', 'm'), idempotencyForDiscord('c', 'n'));
  });
});

describe('DiscordSource.markPicked — deferred thread creation', () => {
  it('creates thread on-demand when ingest used a deferring DiscordOut (HTTP path)', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const threadId = 'thr-late';
      const calls: string[] = [];

      // Deferring out: postTaskCreated returns empty string (control-plane path)
      const deferringOut: DiscordOut = {
        postTaskCreated: async () => ({ threadId: '' }),
        postProgress: async (tid, msg) => { calls.push(`progress:${tid}:${msg}`); },
        postPlanForApproval: async () => ({ messageId: '' }),
        postCompleted: async () => undefined,
        postFailed: async () => undefined,
      };

      // Real out used by daemon (returns a real threadId)
      const daemonOut: DiscordOut = {
        postTaskCreated: async () => { calls.push('created'); return { threadId }; },
        postProgress: async (tid, msg) => { calls.push(`progress:${tid}:${msg}`); },
        postPlanForApproval: async () => ({ messageId: '' }),
        postCompleted: async () => undefined,
        postFailed: async () => undefined,
      };

      // server.ts path: ingest with deferring out → empty threadId stored
      const serverSource = new DiscordSource({ router: mockRouter(ROUTE), out: deferringOut });
      const task = await serverSource.ingest(
        { goal: 'fix bug', channelId: ROUTE.channelId, messageId: 'm-defer', userId: 'u', userLabel: 'Seb' },
        store,
      );
      assert.equal(task.source.kind === 'discord' ? task.source.threadId : 'x', '');

      // daemon path: markPicked with real out + store → creates thread, persists it
      const daemonSource = new DiscordSource({ router: mockRouter(ROUTE), out: daemonOut, store });
      await daemonSource.markPicked(task);

      assert.ok(calls.includes('created'), 'postTaskCreated called to create deferred thread');
      assert.ok(calls.some((c) => c.startsWith(`progress:${threadId}:`)), 'progress posted to real threadId');
      // in-memory task updated
      assert.equal(task.source.kind === 'discord' ? task.source.threadId : '', threadId);
      // store persisted
      const reloaded = store.getById(task.id);
      assert.equal(reloaded?.source.kind === 'discord' ? reloaded.source.threadId : '', threadId);
    } finally {
      cleanup();
    }
  });
});
