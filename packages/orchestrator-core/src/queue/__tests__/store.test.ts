import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { QueuedTask } from '@wahq/orchestrator-core/contracts/task';
import type { RecordPrDecisionInput } from '@wahq/orchestrator-core/queue/store';
import { ulid } from '@wahq/orchestrator-core/utils/ulid';

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
      // pickNext() now atomically claims the row, so state is in_flight on return.
      assert.equal(repicked?.state, 'in_flight');
      store.close();
    } finally {
      cleanup();
    }
  });

  // AUDIT-IFleet-6a9857a0: the old predicates (`attempts >= maxAttempts` to fail,
  // `attempts + 1 < maxAttempts` to requeue) left a gap at `attempts == maxAttempts - 1`
  // — that row matched NEITHER branch and was stranded in_flight forever. These tests
  // pin the boundary: every stale row must transition (to pending or failed), never stay.
  it('recoverStale requeues a stale row at attempts == maxAttempts - 1 (never left in_flight)', async () => {
    const prevMax = process.env['IFLEET_MAX_ATTEMPTS'];
    process.env['IFLEET_MAX_ATTEMPTS'] = '3';
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t = fakeGithubTask({ idempotencyKey: 'boundary-below' });
      store.insert(t);
      store.updateState(t.id, 'in_flight');
      // Force attempts to maxAttempts - 1 (= 2) — the value that used to fall through.
      store.getDb().prepare(`UPDATE tasks SET attempts = 2 WHERE id = @id`).run({ id: t.id });

      // maxAgeMs of 0 → any in_flight row whose picked_at is strictly in the past qualifies.
      await new Promise((r) => setTimeout(r, 5));
      const moved = store.recoverStale(0);
      assert.equal(moved, 1, 'the boundary row must be counted as recovered');
      const got = store.getById(t.id)!;
      assert.equal(got.state, 'pending', 'attempts == maxAttempts-1 must requeue, not stay in_flight');
      store.close();
    } finally {
      cleanup();
      if (prevMax === undefined) delete process.env['IFLEET_MAX_ATTEMPTS'];
      else process.env['IFLEET_MAX_ATTEMPTS'] = prevMax;
    }
  });

  it('recoverStale dead-letters a stale row at attempts == maxAttempts (never left in_flight)', async () => {
    const prevMax = process.env['IFLEET_MAX_ATTEMPTS'];
    process.env['IFLEET_MAX_ATTEMPTS'] = '3';
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t = fakeGithubTask({ idempotencyKey: 'boundary-at' });
      store.insert(t);
      store.updateState(t.id, 'in_flight');
      // attempts == maxAttempts (= 3) → the cap is hit, must fail.
      store.getDb().prepare(`UPDATE tasks SET attempts = 3 WHERE id = @id`).run({ id: t.id });

      await new Promise((r) => setTimeout(r, 5));
      const moved = store.recoverStale(0);
      assert.equal(moved, 1, 'the capped row must be counted as failed');
      const got = store.getById(t.id)!;
      assert.equal(got.state, 'failed', 'attempts == maxAttempts must dead-letter, not stay in_flight');
      assert.equal((got.stateMeta as { reason: string }).reason, 'max-attempts');
      store.close();
    } finally {
      cleanup();
      if (prevMax === undefined) delete process.env['IFLEET_MAX_ATTEMPTS'];
      else process.env['IFLEET_MAX_ATTEMPTS'] = prevMax;
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

  it('recordPrDecision stores and returns a PrDecision', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask();
      store.insert(task);
      const input: RecordPrDecisionInput = {
        taskId: task.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 42,
        verdict: 'merged',
        reviewerLogin: 'octocat',
        mergedAt: Date.now(),
      };
      const decision = store.recordPrDecision(input);
      assert.ok(decision.id.startsWith('prd_'));
      assert.equal(decision.taskId, task.id);
      assert.equal(decision.repo, 'weautomatehq1/IFleet');
      assert.equal(decision.prNumber, 42);
      assert.equal(decision.verdict, 'merged');
      assert.equal(decision.reviewerLogin, 'octocat');
      assert.ok(typeof decision.mergedAt === 'number');
      assert.ok(typeof decision.createdAt === 'number');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('recordPrDecision accepts optional fields as null', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'opt-null' });
      store.insert(task);
      const decision = store.recordPrDecision({
        taskId: task.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 7,
        verdict: 'rejected',
      });
      assert.equal(decision.reviewerLogin, null);
      assert.equal(decision.mergedAt, null);
      assert.equal(decision.verdict, 'rejected');
      store.close();
    } finally {
      cleanup();
    }
  });

  it('getPrDecisionsByRepo returns decisions newest-first, filtered by repo', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const t1 = fakeGithubTask({ idempotencyKey: 'r1' });
      const t2 = fakeGithubTask({ idempotencyKey: 'r2', repo: 'org/other' });
      store.insert(t1);
      store.insert(t2);

      store.recordPrDecision({
        taskId: t1.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 1,
        verdict: 'merged',
      });
      store.recordPrDecision({
        taskId: t1.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 2,
        verdict: 'abandoned',
      });
      store.recordPrDecision({
        taskId: t2.id,
        repo: 'org/other',
        prNumber: 99,
        verdict: 'merged',
      });

      const fleet = store.getPrDecisionsByRepo('weautomatehq1/IFleet');
      assert.equal(fleet.length, 2);
      // newest first
      assert.equal(fleet[0]!.prNumber, 2);
      assert.equal(fleet[1]!.prNumber, 1);

      const other = store.getPrDecisionsByRepo('org/other');
      assert.equal(other.length, 1);
      assert.equal(other[0]!.prNumber, 99);

      const none = store.getPrDecisionsByRepo('org/missing');
      assert.equal(none.length, 0);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('getPrDecisionsByRepo respects limit', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'lim-1' });
      store.insert(task);
      for (let i = 0; i < 5; i++) {
        store.recordPrDecision({
          taskId: task.id,
          repo: 'weautomatehq1/IFleet',
          prNumber: i + 1,
          verdict: 'merged',
        });
      }
      const results = store.getPrDecisionsByRepo('weautomatehq1/IFleet', 3);
      assert.equal(results.length, 3);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('recordPrDecision is idempotent on (taskId, prNumber)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'dedup-1' });
      store.insert(task);
      const first = store.recordPrDecision({
        taskId: task.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 99,
        verdict: 'merged',
      });
      const second = store.recordPrDecision({
        taskId: task.id,
        repo: 'weautomatehq1/IFleet',
        prNumber: 99,
        verdict: 'rejected', // different verdict to confirm the first row is returned
      });
      // Only one row should exist; second call returns the existing decision.
      assert.equal(first.id, second.id);
      assert.equal(second.verdict, 'merged');
      const all = store.getPrDecisionsByRepo('weautomatehq1/IFleet');
      assert.equal(all.length, 1);
      store.close();
    } finally {
      cleanup();
    }
  });

  // NOTE: setRoutingDecision + routing_shadow_log/bandit_arm_state assertions
  // moved to src/agents/bandit/__tests__/store-extensions.test.ts — those are
  // IFleet schema extensions, not part of core's 4-table store. The
  // routing_decision COLUMN round-trip below stays here (it's a core column).

  it('routing_decision column round-trips a raw JSON write (core column)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'm6-route-1' });
      store.insert(task);

      // Untouched row reads back with routingDecision === null.
      assert.equal(store.getById(task.id)!.routingDecision, null);

      const decision = {
        architect: { provider: 'claude' as const, model: 'claude-opus-4-7', workerId: 'w1' },
        editor: { provider: 'claude' as const, model: 'claude-sonnet-4-6', workerId: 'w2' },
        reviewer: { provider: 'claude' as const, model: 'claude-sonnet-4-6', workerId: 'w3' },
        verify: ['typecheck' as const],
      };
      // Core exposes getDb() but not setRoutingDecision (that helper is
      // IFleet-side). Write the core column directly to prove the round-trip.
      store
        .getDb()
        .prepare(`UPDATE tasks SET routing_decision = @d WHERE id = @id`)
        .run({ id: task.id, d: JSON.stringify(decision) });

      const round = store.getById(task.id)!;
      assert.deepEqual(round.routingDecision, decision);
      store.close();
    } finally {
      cleanup();
    }
  });

  it('insert→load round-trips task.mode (AUDIT-IFleet-4a3c058d)', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask({ idempotencyKey: 'mode-rt-1', mode: 'ralph' });
      store.insert(task);

      const got = store.getById(task.id)!;
      assert.equal(got.mode, 'ralph', 'mode must survive a persist→load round-trip');

      // A task with no mode reads back as null (not undefined-via-missing-column).
      const plain = fakeGithubTask({ idempotencyKey: 'mode-rt-2' });
      store.insert(plain);
      assert.equal(store.getById(plain.id)!.mode, null, 'absent mode round-trips to null');
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

describe('TaskStore.pickNext — claim atomicity', () => {
  it('TOCTOU: two stores on the same DB cannot both claim the same task — AUDIT-IFleet-de355093', () => {
    const { path, cleanup } = tmpDb();
    try {
      // Two TaskStore handles on the same file ≈ two daemon processes.
      const storeA = new TaskStore(path);
      const storeB = new TaskStore(path);

      storeA.insert(fakeGithubTask());

      // Both call pickNext (synchronous, same event-loop tick — unit-test
      // approximation of cross-process contention). BEGIN IMMEDIATE ensures
      // the second call finds no pending row after the first claims it.
      const claimedA = storeA.pickNext();
      const claimedB = storeB.pickNext();

      const winners = [claimedA, claimedB].filter(Boolean);
      assert.equal(
        winners.length,
        1,
        `exactly one pickNext must claim the task; got ${JSON.stringify([claimedA?.id, claimedB?.id])}`,
      );

      storeA.close();
      storeB.close();
    } finally {
      cleanup();
    }
  });

  it('pickNext returns task already in in_flight state — no separate updateState needed', () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = new TaskStore(path);
      const task = fakeGithubTask();
      store.insert(task);

      const claimed = store.pickNext();
      if (!claimed) throw new Error('expected pickNext to return a task');
      assert.equal(claimed.state, 'in_flight', 'returned task must already be in_flight');

      // DB row must be in_flight; a second pickNext must return null.
      assert.equal(store.pickNext(), null, 'task must not be re-claimable after pickNext');

      store.close();
    } finally {
      cleanup();
    }
  });
});

describe('SqliteNonceLedger', () => {
  it('TOCTOU: two ledgers on the same DB accept the same nonce exactly once — AUDIT-IFleet-cf106efc', async () => {
    const { path, cleanup } = tmpDb();
    try {
      const ttlMs = 6 * 60 * 1000;
      const nonce = 'toctou-race-nonce';

      // Two TaskStore handles on the same file ≈ two control-plane processes.
      const storeA = new TaskStore(path);
      const storeB = new TaskStore(path);
      const ledgerA = storeA.createNonceLedger(ttlMs);
      const ledgerB = storeB.createNonceLedger(ttlMs);

      const now = Date.now();
      const results = await Promise.all([
        Promise.resolve(ledgerA.registerOrReject(nonce, now)),
        Promise.resolve(ledgerB.registerOrReject(nonce, now)),
      ]);

      const trueCount = results.filter(Boolean).length;
      assert.equal(
        trueCount,
        1,
        `exactly one registerOrReject must return true under contention; got ${JSON.stringify(results)}`,
      );

      ledgerA.destroy();
      ledgerB.destroy();
      storeA.close();
      storeB.close();
    } finally {
      cleanup();
    }
  });

  it('prunes expired entries inside the same transaction as the insert', () => {
    const { path, cleanup } = tmpDb();
    try {
      const ttlMs = 1000;
      const store = new TaskStore(path);
      const ledger = store.createNonceLedger(ttlMs);

      const past = Date.now() - ttlMs - 1;
      assert.equal(ledger.registerOrReject('stale', past), true);
      assert.equal(ledger.size(), 1);

      // A fresh call must prune the stale row inside the same BEGIN IMMEDIATE
      // txn so the table never grows beyond the TTL window.
      assert.equal(ledger.registerOrReject('fresh'), true);
      assert.equal(ledger.size(), 1);

      ledger.destroy();
      store.close();
    } finally {
      cleanup();
    }
  });
});
