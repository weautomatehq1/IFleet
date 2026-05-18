import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { TaskStore } from '../store.js';
import type { QueuedTask } from '../../contracts/task.js';
import { ulid } from '../../utils/ulid.js';

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-store-'));
  const path = join(dir, 'tasks.db');
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeGithubTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: ulid(),
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: 'I_kw1',
      url: 'https://github.com/weautomatehq1/IFleet/issues/1',
    },
    repo: 'weautomatehq1/IFleet',
    brief: 'do thing',
    title: 'do thing',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey: 'gh:I_kw1',
    state: 'pending',
    ...overrides,
  };
}

function fakeDiscordTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: ulid(),
    source: {
      kind: 'discord',
      channelId: '1504120127791042631',
      messageId: 'mid-1',
      userId: 'uid-1',
      userLabel: 'Sebas',
    },
    repo: 'weautomatehq1/Allstate',
    brief: 'add login page',
    title: 'add login page',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto', model: 'opus' },
    createdAt: Date.now(),
    idempotencyKey: 'discord:c1:m1',
    state: 'pending',
    ...overrides,
  };
}

describe('TaskStore', () => {
  it('inserts and retrieves by id', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask();
      const res = store.insert(task);
      assert.equal(res.inserted, true);
      const got = store.getById(task.id);
      assert.ok(got);
      assert.equal(got?.repo, task.repo);
      assert.equal(got?.source.kind, 'github');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('is idempotent on idempotencyKey', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const a = fakeGithubTask({ id: ulid() });
      const b = fakeGithubTask({ id: ulid(), brief: 'updated body' });
      assert.equal(store.insert(a).inserted, true);
      const second = store.insert(b);
      assert.equal(second.inserted, false);
      assert.equal(second.existing?.id, a.id);
      assert.equal(store.count(), 1);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('pickNext returns oldest pending and filters by repo', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const older = fakeGithubTask({
        id: ulid(),
        createdAt: 1000,
        idempotencyKey: 'a',
        repo: 'org/repoA',
      });
      const newer = fakeGithubTask({
        id: ulid(),
        createdAt: 2000,
        idempotencyKey: 'b',
        repo: 'org/repoB',
      });
      store.insert(newer);
      store.insert(older);

      const next = store.pickNext();
      assert.equal(next?.idempotencyKey, 'a');
      const filtered = store.pickNext({ repo: 'org/repoB' });
      assert.equal(filtered?.idempotencyKey, 'b');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('updateState transitions and skips completed in pickNext', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t = fakeGithubTask();
      store.insert(t);
      store.updateState(t.id, 'in_flight');
      assert.equal(store.pickNext(), null);
      store.updateState(t.id, 'done', { pr: 'https://x' });
      const got = store.getById(t.id);
      assert.equal(got?.state, 'done');
      assert.equal((got?.stateMeta as { pr: string }).pr, 'https://x');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('pickNext honors priority before created_at (HIGH-4)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      // Older "normal" task should lose to a newer "high" task.
      store.insert(
        fakeGithubTask({
          id: ulid(),
          createdAt: 1000,
          idempotencyKey: 'old-normal',
          repo: 'org/r',
          routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
        }),
      );
      store.insert(
        fakeGithubTask({
          id: ulid(),
          createdAt: 5000,
          idempotencyKey: 'new-high',
          repo: 'org/r',
          routingHints: { priority: 'high', verify: [], autonomy: 'auto' },
        }),
      );
      const next = store.pickNext();
      assert.equal(next?.idempotencyKey, 'new-high');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('recoverStale resets old in_flight rows back to pending (HIGH-3)', async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t = fakeGithubTask({ idempotencyKey: 'stale-1' });
      store.insert(t);
      store.updateState(t.id, 'in_flight');
      assert.equal(store.pickNext(), null, 'in_flight should not be repicked');

      // maxAgeMs of 0 → every in_flight row qualifies as stale.
      await new Promise((r) => setTimeout(r, 5));
      const recovered = store.recoverStale(0);
      assert.equal(recovered, 1);
      const repicked = store.pickNext();
      assert.equal(repicked?.id, t.id);
      assert.equal(repicked?.state, 'pending');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('recoverStale leaves fresh in_flight rows alone', async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t = fakeGithubTask({ idempotencyKey: 'fresh' });
      store.insert(t);
      store.updateState(t.id, 'in_flight');
      const recovered = store.recoverStale(60 * 60 * 1000);
      assert.equal(recovered, 0);
      assert.equal(store.pickNext(), null);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('list filters by source and channelId', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      store.insert(fakeGithubTask({ idempotencyKey: 'gh-1' }));
      store.insert(fakeDiscordTask({ idempotencyKey: 'd-1' }));
      const gh = store.list({ source: 'github' });
      assert.equal(gh.length, 1);
      const d = store.list({ source: 'discord' });
      assert.equal(d.length, 1);
      const byChannel = store.list({ channelId: '1504120127791042631' });
      assert.equal(byChannel.length, 1);
      const byMissingChannel = store.list({ channelId: 'nope' });
      assert.equal(byMissingChannel.length, 0);
      store.close();
    } finally {
      cleanup();
    }
  });
});
