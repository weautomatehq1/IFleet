import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { QueuedTask } from '../../contracts/task.js';
import type { TaskSource } from '../sources/base.js';
import { TaskStore } from '../store.js';
import { UnifiedQueueAdapter } from '../unified-adapter.js';

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-unified-'));
  const store = new TaskStore(join(dir, 'tasks.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface RecordingSource extends TaskSource {
  calls: string[];
}

function mockSource(kind: 'github' | 'discord'): RecordingSource {
  const calls: string[] = [];
  const source: TaskSource = {
    kind,
    drain: async () => 0,
    markPicked: async (t) => {
      calls.push(`picked:${t.id}`);
    },
    markCompleted: async (t, pr) => {
      calls.push(`completed:${t.id}:${pr}`);
    },
    markFailed: async (t, reason) => {
      calls.push(`failed:${t.id}:${reason}`);
    },
    markBlocked: async (t, cap) => {
      calls.push(`blocked:${t.id}:${cap}`);
    },
  };
  return Object.assign(source, { calls });
}

function ghTask(id: string): QueuedTask {
  return {
    id,
    source: {
      kind: 'github',
      repo: 'org/repo',
      issueNumber: 1,
      issueNodeId: 'I_1',
      url: 'https://example/issue/1',
    },
    repo: 'org/repo',
    brief: 'do thing',
    title: 'do thing',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey: `gh:${id}`,
  };
}

function discordTask(id: string): QueuedTask {
  return {
    id,
    source: {
      kind: 'discord',
      channelId: 'chan-1',
      messageId: 'msg-1',
      threadId: 'thr-1',
      userId: 'u-1',
      userLabel: 'seb',
    },
    repo: 'org/repo',
    brief: 'discord goal',
    title: 'discord goal',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey: `dc:${id}`,
  };
}

describe('UnifiedQueueAdapter', () => {
  it('pickNext routes github task to GitHub source AND flips state to in_flight', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const t = ghTask('t1');
      store.insert(t);
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      const picked = await adapter.pickNext();
      assert.equal(picked?.id, 't1');
      assert.equal(store.getById('t1')?.state, 'in_flight');
      assert.deepEqual(github.calls, ['picked:t1']);
      assert.deepEqual(discord.calls, []);
    } finally {
      cleanup();
    }
  });

  it('pickNext routes discord task to Discord source', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const t = discordTask('t2');
      store.insert(t);
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      const picked = await adapter.pickNext();
      assert.equal(picked?.id, 't2');
      assert.equal(store.getById('t2')?.state, 'in_flight');
      assert.deepEqual(discord.calls, ['picked:t2']);
      assert.deepEqual(github.calls, []);
    } finally {
      cleanup();
    }
  });

  it('pickNext returns null when store has no pending work', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });
      const picked = await adapter.pickNext();
      assert.equal(picked, null);
    } finally {
      cleanup();
    }
  });

  it('markCompleted, markFailed, markBlocked dispatch to the right source and update state', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const tGh = ghTask('tg');
      const tDc = discordTask('td');
      store.insert(tGh);
      store.insert(tDc);
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      await adapter.markCompleted(tGh, 'https://pr/1');
      assert.equal(store.getById('tg')?.state, 'done');
      assert.deepEqual(github.calls, ['completed:tg:https://pr/1']);

      await adapter.markFailed(tDc, 'boom');
      assert.equal(store.getById('td')?.state, 'failed');
      assert.deepEqual(discord.calls, ['failed:td:boom']);

      // Re-insert because the previous discord task is in 'failed' state.
      const tDc2 = discordTask('td2');
      store.insert(tDc2);
      await adapter.markBlocked(tDc2, 'docker');
      assert.equal(store.getById('td2')?.state, 'blocked');
      assert.deepEqual(discord.calls.slice(-1), ['blocked:td2:docker']);
    } finally {
      cleanup();
    }
  });

  // NOTE: markCompleted no longer records pr_decisions directly (AUDIT-IFleet-DBLPRDEC).
  // The single authoritative write is in daemon.ts wireSprintCompletion on sprint.completed.
  // The test below verifies that markCompleted does NOT write a duplicate row.
  it('markCompleted does NOT record a pr_decision (recorded by wireSprintCompletion instead)', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const t = ghTask('rec-1');
      store.insert(t);
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      await adapter.markCompleted(t, 'https://github.com/org/repo/pull/77');

      // Expect NO rows — daemon.ts wireSprintCompletion is the authoritative writer.
      const decisions = store.getPrDecisionsByRepo('org/repo');
      assert.equal(decisions.length, 0, 'markCompleted must not record pr_decisions; that is wireSprintCompletion\'s job');
    } finally {
      cleanup();
    }
  });

  it('markCompleted updates task state to done even without PR number', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const t = ghTask('rec-2');
      store.insert(t);
      const github = mockSource('github');
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      await adapter.markCompleted(t, '');
      assert.equal(store.getById('rec-2')?.state, 'done');
      const decisions = store.getPrDecisionsByRepo('org/repo');
      assert.equal(decisions.length, 0);
    } finally {
      cleanup();
    }
  });

  it('pickNext does not leave row pending if source.markPicked throws', async () => {
    const { store, cleanup } = tmpStore();
    try {
      const t = ghTask('flaky');
      store.insert(t);
      const github: TaskSource = {
        kind: 'github',
        drain: async () => 0,
        markPicked: async () => {
          throw new Error('rate limited');
        },
        markCompleted: async () => {},
        markFailed: async () => {},
        markBlocked: async () => {},
      };
      const discord = mockSource('discord');
      const adapter = new UnifiedQueueAdapter(store, { github, discord });

      const picked = await adapter.pickNext();
      assert.equal(picked?.id, 'flaky');
      assert.equal(store.getById('flaky')?.state, 'in_flight');
    } finally {
      cleanup();
    }
  });
});
