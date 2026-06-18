// M6 follow-up — Per-arm circuit-breaker for the BANDIT_LIVE live-path.
//
// The Thompson sampler picks the best arm by posterior, but a model that
// repeatedly fails (verdict='rejected') keeps drawing tasks until its
// posterior catches up — that lag can burn a lot of merges in the live
// path. The circuit-breaker short-circuits that lag:
//
//   - On `BANDIT_CB_THRESHOLD` (default 5) consecutive failures of an
//     arm, the arm is marked `disabled`.
//   - The next `BANDIT_CB_COOLDOWN` (default 20) task assignments skip
//     the arm — the live path falls back to canonical (correctness-first)
//     routing for that task (`actualModel`, NOT the sampled arm).
//   - After the cooldown expires, the arm transitions to `probing`. The
//     next assignment that would naturally sample it goes through.
//   - On a probe success → arm is re-enabled (`active`, failures reset).
//   - On a probe failure → arm is disabled again for another cooldown.
//
// State lives in `bandit_arm_state`. The schema is forward-compatible
// with the existing in-line ALTER TABLE pattern used by `TaskStore`.
// `ensureCircuitBreakerSchema(db)` is idempotent so tests can stand up
// a fresh in-memory DB without depending on `TaskStore`.
//
// Default OFF stays OFF: the live path only reads CB state when
// `BANDIT_LIVE` is on, and `onAssignment` is only called from that
// branch. `recordOutcome` is the single public mutation point for
// downstream observers (see live.ts: `applyBanditRouting` does NOT
// write outcomes — outcomes come from the PR-decision observer once
// merged/rejected verdicts land in `pr_decisions`).

import type Database from 'better-sqlite3';

export type ArmStatus = 'active' | 'disabled' | 'probing';

export interface ArmCBState {
  arm: string;
  status: ArmStatus;
  consecutiveFailures: number;
  /** Assignments left in the current cooldown window (>0 ⇒ suppressed). */
  assignmentsRemaining: number;
  updatedAt: number;
}

export const BANDIT_CB_THRESHOLD_ENV = 'BANDIT_CB_THRESHOLD';
export const BANDIT_CB_COOLDOWN_ENV = 'BANDIT_CB_COOLDOWN';
export const DEFAULT_CB_THRESHOLD = 5;
export const DEFAULT_CB_COOLDOWN = 20;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function getCBThreshold(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[BANDIT_CB_THRESHOLD_ENV], DEFAULT_CB_THRESHOLD);
}

export function getCBCooldown(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[BANDIT_CB_COOLDOWN_ENV], DEFAULT_CB_COOLDOWN);
}

/**
 * Create the `bandit_arm_state` table if it doesn't exist. Safe to call
 * on every boot — matches the `CREATE TABLE IF NOT EXISTS` pattern in
 * `TaskStore`. Tests call this on the in-memory DB they construct.
 */
export function ensureCircuitBreakerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bandit_arm_state (
      arm TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      assignments_remaining INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

interface Row {
  arm: string;
  status: string;
  consecutive_failures: number;
  assignments_remaining: number;
  updated_at: number;
}

function defaultState(arm: string): ArmCBState {
  return {
    arm,
    status: 'active',
    consecutiveFailures: 0,
    assignmentsRemaining: 0,
    updatedAt: 0,
  };
}

function rowToState(row: Row): ArmCBState {
  return {
    arm: row.arm,
    status: row.status as ArmStatus,
    consecutiveFailures: row.consecutive_failures,
    assignmentsRemaining: row.assignments_remaining,
    updatedAt: row.updated_at,
  };
}

export function getArmState(db: Database.Database, arm: string): ArmCBState {
  const row = db
    .prepare(
      `SELECT arm, status, consecutive_failures, assignments_remaining, updated_at
         FROM bandit_arm_state WHERE arm = ?`,
    )
    .get(arm) as Row | undefined;
  return row ? rowToState(row) : defaultState(arm);
}

function upsertState(db: Database.Database, state: ArmCBState, now: number): void {
  db.prepare(
    `INSERT INTO bandit_arm_state
       (arm, status, consecutive_failures, assignments_remaining, updated_at)
     VALUES (@arm, @status, @consecutive_failures, @assignments_remaining, @updated_at)
     ON CONFLICT(arm) DO UPDATE SET
       status = excluded.status,
       consecutive_failures = excluded.consecutive_failures,
       assignments_remaining = excluded.assignments_remaining,
       updated_at = excluded.updated_at`,
  ).run({
    arm: state.arm,
    status: state.status,
    consecutive_failures: state.consecutiveFailures,
    assignments_remaining: state.assignmentsRemaining,
    updated_at: now,
  });
}

export interface CBOptions {
  threshold?: number;
  cooldown?: number;
  now?: number;
}

/**
 * Apply an arm outcome (success or failure) to the CB state.
 *
 * Success:
 *   - Resets `consecutiveFailures` to 0.
 *   - If status was `probing`, re-enable: status='active', remaining=0.
 *
 * Failure:
 *   - If status was `probing`, the probe failed → status='disabled' with
 *     a fresh cooldown window.
 *   - Otherwise increment `consecutiveFailures`. Once it reaches the
 *     threshold, trip: status='disabled', remaining=cooldown.
 *
 * Returns the new state.
 */
export function recordOutcome(
  db: Database.Database,
  arm: string,
  success: boolean,
  opts: CBOptions = {},
): ArmCBState {
  const threshold = opts.threshold ?? getCBThreshold();
  const cooldown = opts.cooldown ?? getCBCooldown();
  const now = opts.now ?? Date.now();
  const state = getArmState(db, arm);

  if (success) {
    state.consecutiveFailures = 0;
    if (state.status === 'probing' || state.status === 'disabled') {
      state.status = 'active';
      state.assignmentsRemaining = 0;
    }
  } else {
    if (state.status === 'probing') {
      // Probe failed → straight back to disabled with a fresh window.
      state.status = 'disabled';
      state.assignmentsRemaining = cooldown;
      state.consecutiveFailures += 1;
    } else {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= threshold && state.status !== 'disabled') {
        state.status = 'disabled';
        state.assignmentsRemaining = cooldown;
      }
    }
  }

  upsertState(db, state, now);
  return state;
}

/**
 * Record that an assignment was attempted. For each known arm with a
 * disabled status, decrement the cooldown counter. When the counter hits
 * 0, the arm becomes `probing` — the next assignment that picks it goes
 * through as the probe.
 *
 * Only called from the LIVE path. OFF (BANDIT_LIVE off) ⇒ never called
 * ⇒ no CB state mutation.
 */
export function onAssignment(
  db: Database.Database,
  knownArms: readonly string[],
  opts: { now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  for (const arm of knownArms) {
    const state = getArmState(db, arm);
    if (state.status !== 'disabled') continue;
    state.assignmentsRemaining -= 1;
    if (state.assignmentsRemaining <= 0) {
      state.assignmentsRemaining = 0;
      state.status = 'probing';
    }
    upsertState(db, state, now);
  }
}

/**
 * Returns true iff the arm is currently allowed to be promoted to the
 * actual routing decision. `active` and `probing` arms are allowed;
 * `disabled` arms (cooldown > 0) are suppressed.
 */
export function isArmEligible(db: Database.Database, arm: string): boolean {
  const state = getArmState(db, arm);
  return state.status !== 'disabled';
}
