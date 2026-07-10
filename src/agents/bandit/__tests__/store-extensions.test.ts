import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { QueuedTask } from '@wahq/orchestrator-core/contracts/task';
import { ulid } from '@wahq/orchestrator-core/utils/ulid';
import { IFLEET_STORE_EXTENSIONS, setRoutingDecision } from '../store-extensions.js';

// These assertions used to live in queue/store.test.ts back when core's
// TaskStore created routing_shadow_log + bandit_arm_state and exposed
// setRoutingDecision. After the @wahq/orchestrator-core extraction core owns
// exactly the 4 core tables; the bandit tables + the setRoutingDecision helper
// are IFleet-side, injected via the `extensions` ctor hook. This test proves
// the extension hook + helper reproduce the prior behavior byte-for-byte.

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-store-ext-'));
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

function newStore(path: string): TaskStore {
  return new TaskStore(path, { extensions: IFLEET_STORE_EXTENSIONS });
}

describe('IFLEET_STORE_EXTENSIONS + setRoutingDecision', () => {
  it('setRoutingDecision persists JSON; rowToTask round-trips it (M6-T3)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = newStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'm6-route-1' });
      store.insert(task);

      // Untouched row reads back with routingDecision === null.
      expect(store.getById(task.id)!.routingDecision).toBe(null);

      const decision = {
        architect: { provider: 'claude' as const, model: 'claude-opus-4-7', workerId: 'w1' },
        editor: { provider: 'claude' as const, model: 'claude-sonnet-4-6', workerId: 'w2' },
        reviewer: { provider: 'claude' as const, model: 'claude-sonnet-4-6', workerId: 'w3' },
        verify: ['typecheck' as const],
      };
      setRoutingDecision(store, task.id, decision);

      const round = store.getById(task.id)!;
      expect(round.routingDecision).toEqual(decision);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('routing_shadow_log is created by the extension (shadow recorder writes through getDb)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = newStore(path);
      const db = store.getDb();
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='routing_shadow_log'`)
        .get() as { name: string } | undefined;
      expect(row).toBeTruthy();
      store.close();
    } finally {
      cleanup();
    }
  });

  it("routing_shadow_log has the role column post-construction with DEFAULT 'architect' (M6-T3 follow-up)", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = newStore(path);
      const db = store.getDb();
      const cols = db.pragma('table_info(routing_shadow_log)') as Array<{
        name: string;
        dflt_value: string | null;
        notnull: number;
      }>;
      const role = cols.find((c) => c.name === 'role');
      expect(role).toBeTruthy();
      expect(role!.notnull).toBe(1);
      // DEFAULT comes back quoted from pragma — accept either form.
      expect(String(role!.dflt_value ?? '')).toMatch(/^'?architect'?$/);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('bandit_arm_state is created by the extension', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = newStore(path);
      const db = store.getDb();
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bandit_arm_state'`)
        .get() as { name: string } | undefined;
      expect(row).toBeTruthy();
      store.close();
    } finally {
      cleanup();
    }
  });

  it('core store WITHOUT extensions creates none of the bandit tables (4-table boundary)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path); // no extensions
      const db = store.getDb();
      for (const t of ['routing_shadow_log', 'bandit_arm_state']) {
        const row = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(t) as { name: string } | undefined;
        expect(row).toBeUndefined();
      }
      store.close();
    } finally {
      cleanup();
    }
  });
});
