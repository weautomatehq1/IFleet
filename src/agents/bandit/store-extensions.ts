import type Database from 'better-sqlite3';
import type { StoreExtension } from '@wahq/orchestrator-core/queue/store';
import type { RoutingDecision } from '@wahq/orchestrator-core/contracts/routing';

// IFleet-owned TaskStore schema extensions. @wahq/orchestrator-core owns exactly
// the 4 core tables (tasks, pr_decisions, nonce_ledger, discord_outbox); these
// bandit tables are product-specific, so IFleet injects them via the store's
// `extensions` ctor hook rather than having core create them. Each extension is
// idempotent (CREATE TABLE IF NOT EXISTS + swallow duplicate-column ALTERs) and
// runs once, after core DDL, at construction — byte-for-byte the DDL that used
// to live inline in core's store.ts before the extraction.

/**
 * M6-T2: routing_shadow_log — the bandit's would-be model pick captured per
 * task without overriding live routing. Snapshot columns are JSON blobs so the
 * analytics dashboard can reconstruct the posteriors at decision time. FK to
 * tasks(id) keeps the log clean on task deletes.
 */
const routingShadowLog: StoreExtension = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_shadow_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      decided_at INTEGER NOT NULL,
      actual_model TEXT NOT NULL,
      shadow_model TEXT NOT NULL,
      alpha_snapshot TEXT NOT NULL,
      beta_snapshot TEXT NOT NULL,
      sample_snapshot TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'architect',
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_routing_shadow_task ON routing_shadow_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_routing_shadow_decided
      ON routing_shadow_log(decided_at);
  `);
  // M6-T3 follow-up: backfill the role column on DBs created before this
  // migration. Pre-this-PR rows came from the architect-only wiring (PR #362),
  // so DEFAULT 'architect' is the correct backfill.
  try {
    db.exec(`ALTER TABLE routing_shadow_log ADD COLUMN role TEXT NOT NULL DEFAULT 'architect'`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_routing_shadow_role ON routing_shadow_log(role)`);
};

/**
 * M6 follow-up — per-arm circuit-breaker state (BANDIT_LIVE live-path). OFF by
 * default and OFF for every shadow-only deployment because the table only gets
 * written when `resolveRoutingModel` runs with live=true. Schema details live
 * in src/agents/bandit/circuit-breaker.ts.
 */
const banditArmState: StoreExtension = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bandit_arm_state (
      arm TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      assignments_remaining INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
};

/**
 * The IFleet TaskStore schema extensions, in run order. Pass to
 * `new TaskStore(path, { extensions: IFLEET_STORE_EXTENSIONS })` at every
 * IFleet construction site so the bandit tables exist.
 */
export const IFLEET_STORE_EXTENSIONS: StoreExtension[] = [routingShadowLog, banditArmState];

/**
 * Persist the live RoutingDecision for `taskId`. Single UPDATE — overwrites any
 * prior value. `src/pipeline/factory.ts` calls this immediately after
 * `classifyTask(...)` so the Thompson observations reader has a stable
 * `(arm, reward)` history to join against once `pr_decisions` populates.
 *
 * The `routing_decision` column itself is core (it's part of QueuedTask); this
 * writer stays IFleet-side because only the bandit shadow path needs it, and
 * core no longer exposes `setRoutingDecision` on TaskStore.
 */
export function setRoutingDecision(
  store: { getDb(): Database.Database },
  taskId: string,
  decision: RoutingDecision,
): void {
  store
    .getDb()
    .prepare(`UPDATE tasks SET routing_decision = @decision WHERE id = @id`)
    .run({ id: taskId, decision: JSON.stringify(decision) });
}
