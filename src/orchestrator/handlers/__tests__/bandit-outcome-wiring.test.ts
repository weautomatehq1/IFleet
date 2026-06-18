/**
 * B2 (2026-06-18) — recordOutcome wired from the PR-decision observer.
 *
 * Before this wiring landed the `recordOutcome` export from
 * `src/agents/bandit/circuit-breaker.ts` had no production caller, so the
 * per-arm circuit-breaker shipped in PR #394 was inert regardless of
 * `BANDIT_LIVE`. These tests pin the wiring contract:
 *
 *   1. Off-flag (`BANDIT_LIVE` unset or anything other than '1'/'true')
 *      ⇒ zero `bandit_arm_state` mutations.
 *   2. Five rejected verdicts in a row on the same arm trip the arm:
 *      `isArmEligible` is false on the 6th assignment.
 *   3. Mid-cooldown the disabled arm stays ineligible.
 *   4. A probe-success after cooldown re-enables the arm.
 *   5. A probe-failure after cooldown re-disables the arm.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordBanditOutcomeForTask } from '../pr-decisions.js';
import { TaskStore } from '../../../queue/store.js';
import {
  DEFAULT_CB_COOLDOWN,
  DEFAULT_CB_THRESHOLD,
  isArmEligible,
  onAssignment,
} from '../../../agents/bandit/circuit-breaker.js';
import type { QueuedTask } from '../../../contracts/task.js';
import type { RoutingDecision } from '../../../pipeline/types.js';

const OPUS = 'claude-opus-4-7';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5-20251001';
const KNOWN_ARMS = [OPUS, SONNET, HAIKU];

function tmpStore(): { store: TaskStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-bandit-wire-'));
  const store = new TaskStore(join(dir, 'tasks.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ghTask(id: string): QueuedTask {
  return {
    id,
    source: {
      kind: 'github',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 1,
      issueNodeId: `node_${id}`,
      url: `https://github.com/weautomatehq1/IFleet/issues/1`,
    },
    repo: 'weautomatehq1/IFleet',
    brief: 'b2 wiring test',
    title: 'b2 wiring test',
    routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
    createdAt: Date.now(),
    idempotencyKey: `gh:${id}`,
  };
}

function makeRouting(model: string): RoutingDecision {
  const spec = { provider: 'claude' as const, model, workerId: 'w1' };
  return {
    architect: spec,
    editor: spec,
    reviewer: spec,
    verify: [],
  };
}

function persistTaskWithRouting(store: TaskStore, id: string, model: string): QueuedTask {
  const task = ghTask(id);
  store.insert(task);
  store.setRoutingDecision(id, makeRouting(model));
  const fresh = store.getById(id);
  if (!fresh) throw new Error('task not persisted');
  return fresh;
}

describe('B2 — recordBanditOutcomeForTask wiring', () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env['BANDIT_LIVE'];
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env['BANDIT_LIVE'];
    else process.env['BANDIT_LIVE'] = envBackup;
  });

  test('off-flag: BANDIT_LIVE unset ⇒ no CB mutation even after 10 failures', () => {
    delete process.env['BANDIT_LIVE'];
    const { store, cleanup } = tmpStore();
    try {
      for (let i = 0; i < 10; i++) {
        const t = persistTaskWithRouting(store, `t${i}`, OPUS);
        recordBanditOutcomeForTask(store, t, false);
      }
      // No row should have been written.
      const db = store.getDb();
      const rows = db.prepare(`SELECT COUNT(*) AS n FROM bandit_arm_state`).get() as { n: number };
      assert.equal(rows.n, 0, 'bandit_arm_state must stay empty when BANDIT_LIVE is off');
      assert.equal(isArmEligible(db, OPUS), true);
    } finally {
      cleanup();
    }
  });

  test('5 rejected verdicts on the same arm trip the CB; arm ineligible on 6th assignment', () => {
    process.env['BANDIT_LIVE'] = '1';
    const { store, cleanup } = tmpStore();
    try {
      const db = store.getDb();
      assert.equal(DEFAULT_CB_THRESHOLD, 5, 'test wired to threshold=5');
      for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) {
        const t = persistTaskWithRouting(store, `t${i}`, OPUS);
        assert.equal(isArmEligible(db, OPUS), true, `eligible before reject #${i + 1}`);
        recordBanditOutcomeForTask(store, t, false);
      }
      assert.equal(isArmEligible(db, OPUS), false, 'tripped after 5 rejections');
      // Sibling arms must still be eligible — only OPUS failed.
      assert.equal(isArmEligible(db, SONNET), true);
      assert.equal(isArmEligible(db, HAIKU), true);
    } finally {
      cleanup();
    }
  });

  test('mid-cooldown: disabled arm stays ineligible until cooldown drains', () => {
    process.env['BANDIT_LIVE'] = '1';
    const { store, cleanup } = tmpStore();
    try {
      const db = store.getDb();
      for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) {
        const t = persistTaskWithRouting(store, `t${i}`, OPUS);
        recordBanditOutcomeForTask(store, t, false);
      }
      assert.equal(isArmEligible(db, OPUS), false);
      // Halfway through the cooldown window the arm is still suppressed.
      const half = Math.floor(DEFAULT_CB_COOLDOWN / 2);
      for (let i = 0; i < half; i++) onAssignment(db, KNOWN_ARMS, { now: 1000 + i });
      assert.equal(isArmEligible(db, OPUS), false, 'still suppressed mid-cooldown');
    } finally {
      cleanup();
    }
  });

  test('probe-success after cooldown re-enables the arm', () => {
    process.env['BANDIT_LIVE'] = '1';
    const { store, cleanup } = tmpStore();
    try {
      const db = store.getDb();
      for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) {
        const t = persistTaskWithRouting(store, `tr${i}`, OPUS);
        recordBanditOutcomeForTask(store, t, false);
      }
      assert.equal(isArmEligible(db, OPUS), false);
      // Drain the cooldown — arm transitions to `probing`, still eligible.
      for (let i = 0; i < DEFAULT_CB_COOLDOWN; i++) onAssignment(db, KNOWN_ARMS, { now: 2000 + i });
      assert.equal(isArmEligible(db, OPUS), true, 'probing arms are eligible');
      // A merged verdict during the probe re-enables the arm fully.
      const probeTask = persistTaskWithRouting(store, 'probe-ok', OPUS);
      recordBanditOutcomeForTask(store, probeTask, true);
      assert.equal(isArmEligible(db, OPUS), true);
      // After the probe success the arm should sustain further failures without
      // immediately re-tripping (consecutiveFailures was reset).
      const next = persistTaskWithRouting(store, 'after-probe', OPUS);
      recordBanditOutcomeForTask(store, next, false);
      assert.equal(isArmEligible(db, OPUS), true, 'one failure post-probe is not enough to re-trip');
    } finally {
      cleanup();
    }
  });

  test('probe-failure after cooldown re-disables the arm immediately', () => {
    process.env['BANDIT_LIVE'] = '1';
    const { store, cleanup } = tmpStore();
    try {
      const db = store.getDb();
      for (let i = 0; i < DEFAULT_CB_THRESHOLD; i++) {
        const t = persistTaskWithRouting(store, `tx${i}`, OPUS);
        recordBanditOutcomeForTask(store, t, false);
      }
      // Cooldown → probing.
      for (let i = 0; i < DEFAULT_CB_COOLDOWN; i++) onAssignment(db, KNOWN_ARMS, { now: 3000 + i });
      assert.equal(isArmEligible(db, OPUS), true, 'probing is eligible');
      // Probe verdict is a rejection ⇒ straight back to disabled.
      const probeTask = persistTaskWithRouting(store, 'probe-fail', OPUS);
      recordBanditOutcomeForTask(store, probeTask, false);
      assert.equal(isArmEligible(db, OPUS), false, 'probe failure re-disables the arm');
    } finally {
      cleanup();
    }
  });
});
