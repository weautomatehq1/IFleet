import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  OrchestratorEvent,
  RateLimitSnapshot,
  SprintId,
  SprintRecord,
  TaskId,
  TaskRecord,
  WorkerId,
} from './types';

export const DEFAULT_DB_PATH = join(homedir(), '.omc', 'ifleet', 'state.db');

interface SprintRow {
  id: string;
  mode: string;
  goal: string;
  state_json: string;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  sprint_id: string;
  brief: string;
  state_json: string;
  attempts: number;
  created_at: number;
  updated_at: number;
  required_capabilities_json: string | null;
}

interface RateLimitRow {
  worker_id: string;
  tokens_remaining: number;
  tokens_limit: number;
  reset_at: number;
  pressure: number;
  observed_at: number;
}

interface SprintRuntimeRow {
  sprint_id: string;
  spent_usd: number;
  rate_reset_at: number | null;
  updated_at: number;
}

export interface SprintRuntimeState {
  spentUsd: number;
  rateResetAt: number | null;
}

const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    goal TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    state_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (sprint_id) REFERENCES sprints(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id)`,
  // Expression index on the sprint state kind. listSprintsByStateKind() filters
  // by state.kind (JSON-extracted) so SQLite can use this index when the JSON
  // path predicate appears literally in the WHERE clause.
  `CREATE INDEX IF NOT EXISTS idx_sprints_state_kind ON sprints(json_extract(state_json, '$.kind'))`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    sprint_id TEXT NOT NULL,
    task_id TEXT,
    worker_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_sprint ON events(sprint_id, ts)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    worker_id TEXT PRIMARY KEY,
    tokens_remaining INTEGER NOT NULL,
    tokens_limit INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    pressure REAL NOT NULL,
    observed_at INTEGER NOT NULL
  )`,
  // Per-sprint runtime counters that must survive a process restart. Kept in
  // a separate table from `sprints` so the migration is additive and the
  // sprint state machine (which lives in state_json) stays untouched. Rows
  // are upserted as the SprintManager accumulates cost or detects a rate
  // pause, and rehydrated into in-memory Maps on construction.
  `CREATE TABLE IF NOT EXISTS sprint_runtime_state (
    sprint_id TEXT PRIMARY KEY,
    spent_usd REAL NOT NULL DEFAULT 0,
    rate_reset_at INTEGER,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (sprint_id) REFERENCES sprints(id)
  )`,
  // Closed-loop verifier runs (M1 / docs/elevation/upgrades/01-verifier.md).
  // One row per VerifierAgent invocation. Created additively in M0.W1 so the
  // M1.W2 implementation can immediately persist results without a follow-up
  // migration. fingerprint_before / fingerprint_after stay NULL until M4
  // (behavioral fingerprinting upgrade).
  `CREATE TABLE IF NOT EXISTS verifier_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    sprint_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    sha TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    cost_usd REAL,
    fingerprint_before TEXT,
    fingerprint_after TEXT,
    raw_log_url TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (sprint_id) REFERENCES sprints(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_verifier_runs_task ON verifier_runs(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_verifier_runs_sprint ON verifier_runs(sprint_id)`,
  // Structured failures parsed from sandbox output. Drives the editor-feedback
  // retry loop in M1.W2 and the canary disagreement-rate metric (task #14).
  `CREATE TABLE IF NOT EXISTS verifier_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    column_num INTEGER,
    message TEXT NOT NULL,
    raw_output TEXT,
    FOREIGN KEY (run_id) REFERENCES verifier_runs(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_verifier_failures_run ON verifier_failures(run_id)`,
];

interface AttemptRecordInput {
  taskId: TaskId;
  workerId: WorkerId;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const tx = this.db.transaction((stmts: ReadonlyArray<string>) => {
      for (const sql of stmts) {
        this.db.exec(sql);
      }
    });
    tx(MIGRATIONS);
    // Idempotent column additions: ALTER TABLE is not repeatable, so guard via pragma.
    const taskCols = (this.db.pragma('table_info(tasks)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!taskCols.includes('required_capabilities_json')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN required_capabilities_json TEXT');
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  saveSprint(record: SprintRecord): void {
    const insert = this.db.prepare(
      `INSERT INTO sprints (id, mode, goal, state_json, created_at, updated_at)
       VALUES (@id, @mode, @goal, @state, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         mode = excluded.mode,
         goal = excluded.goal,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    );
    const upsertTask = this.db.prepare(
      `INSERT INTO tasks (id, sprint_id, brief, state_json, attempts, created_at, updated_at, required_capabilities_json)
       VALUES (@id, @sprintId, @brief, @state, @attempts, @createdAt, @updatedAt, @requiredCapabilitiesJson)
       ON CONFLICT(id) DO UPDATE SET
         brief = excluded.brief,
         state_json = excluded.state_json,
         attempts = excluded.attempts,
         updated_at = excluded.updated_at,
         required_capabilities_json = excluded.required_capabilities_json`,
    );
    const tx = this.db.transaction((rec: SprintRecord) => {
      insert.run({
        id: rec.id,
        mode: rec.mode,
        goal: rec.goal,
        state: JSON.stringify(rec.state),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      });
      for (const taskId of rec.tasks) {
        const existing = this.db
          .prepare('SELECT id FROM tasks WHERE id = ?')
          .get(taskId) as { id: string } | undefined;
        if (!existing) {
          upsertTask.run({
            id: taskId,
            sprintId: rec.id,
            brief: '',
            state: JSON.stringify({ kind: 'pending' }),
            attempts: 0,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            requiredCapabilitiesJson: null,
          });
        }
      }
    });
    tx(record);
  }

  saveTask(record: TaskRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, sprint_id, brief, state_json, attempts, created_at, updated_at, required_capabilities_json)
       VALUES (@id, @sprintId, @brief, @state, @attempts, @createdAt, @updatedAt, @requiredCapabilitiesJson)
       ON CONFLICT(id) DO UPDATE SET
         brief = excluded.brief,
         state_json = excluded.state_json,
         attempts = excluded.attempts,
         updated_at = excluded.updated_at,
         required_capabilities_json = excluded.required_capabilities_json`,
    );
    stmt.run({
      id: record.id,
      sprintId: record.sprintId,
      brief: record.brief,
      state: JSON.stringify(record.state),
      attempts: record.attempts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      requiredCapabilitiesJson: record.requiredCapabilities
        ? JSON.stringify(record.requiredCapabilities)
        : null,
    });
  }

  loadSprint(id: SprintId): SprintRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sprints WHERE id = ?').get(id) as
      | SprintRow
      | undefined;
    if (!row) return undefined;
    let state: SprintRecord['state'];
    try {
      state = JSON.parse(row.state_json) as SprintRecord['state'];
    } catch (err) {
      console.error(`loadSprint: corrupt state_json for sprint ${row.id}: ${String(err)}`);
      return undefined;
    }
    const taskRows = this.db
      .prepare('SELECT id FROM tasks WHERE sprint_id = ? ORDER BY created_at ASC')
      .all(id) as ReadonlyArray<{ id: string }>;
    return {
      id: row.id as SprintId,
      mode: row.mode as SprintRecord['mode'],
      goal: row.goal,
      tasks: taskRows.map((t) => t.id as TaskId),
      state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  loadTask(id: TaskId): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    if (!row) return undefined;
    let state: TaskRecord['state'];
    try {
      state = JSON.parse(row.state_json) as TaskRecord['state'];
    } catch (err) {
      console.error(`loadTask: corrupt state_json for task ${row.id}: ${String(err)}`);
      return undefined;
    }
    const base: TaskRecord = {
      id: row.id as TaskId,
      sprintId: row.sprint_id as SprintId,
      brief: row.brief,
      state,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.required_capabilities_json) {
      try {
        base.requiredCapabilities = JSON.parse(row.required_capabilities_json) as string[];
      } catch (err) {
        console.warn(
          `loadTask: corrupt required_capabilities_json for task ${row.id}: ${String(err)}`,
        );
      }
    }
    return base;
  }

  listSprintsByStateKind(kind: string): ReadonlyArray<SprintRecord> {
    // Filter in SQL via the expression index on json_extract(state_json,'$.kind')
    // instead of loading every row and filtering in JS. Avoids a full table
    // scan once the sprints table grows.
    const rows = this.db
      .prepare(`SELECT * FROM sprints WHERE json_extract(state_json, '$.kind') = ?`)
      .all(kind) as ReadonlyArray<SprintRow>;
    const out: SprintRecord[] = [];
    for (const row of rows) {
      let state: SprintRecord['state'];
      try {
        state = JSON.parse(row.state_json) as SprintRecord['state'];
      } catch (err) {
        console.warn(
          `listSprintsByStateKind: corrupt state_json for sprint ${row.id}: ${String(err)}`,
        );
        continue;
      }
      if (state.kind !== kind) continue;
      const taskRows = this.db
        .prepare('SELECT id FROM tasks WHERE sprint_id = ? ORDER BY created_at ASC')
        .all(row.id) as ReadonlyArray<{ id: string }>;
      out.push({
        id: row.id as SprintId,
        mode: row.mode as SprintRecord['mode'],
        goal: row.goal,
        tasks: taskRows.map((t) => t.id as TaskId),
        state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    return out;
  }

  appendEvent(event: OrchestratorEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (ts, sprint_id, task_id, worker_id, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.sprintId,
        event.taskId ?? null,
        event.workerId ?? null,
        event.kind,
        JSON.stringify(event.payload),
      );
  }

  /**
   * Load all events for a sprint, oldest first. The events table is append-only
   * so this is a simple `WHERE sprint_id = ? ORDER BY ts ASC`. Used by tests
   * and the dashboard. Optional `kind` filter narrows to a specific event kind.
   */
  loadEventsBySprint(sprintId: SprintId, kind?: string): ReadonlyArray<OrchestratorEvent> {
    const sql = kind
      ? 'SELECT * FROM events WHERE sprint_id = ? AND kind = ? ORDER BY ts ASC'
      : 'SELECT * FROM events WHERE sprint_id = ? ORDER BY ts ASC';
    const rows = kind
      ? (this.db.prepare(sql).all(sprintId, kind) as Array<{
          ts: number;
          sprint_id: string;
          task_id: string | null;
          worker_id: string | null;
          kind: string;
          payload_json: string;
        }>)
      : (this.db.prepare(sql).all(sprintId) as Array<{
          ts: number;
          sprint_id: string;
          task_id: string | null;
          worker_id: string | null;
          kind: string;
          payload_json: string;
        }>);
    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        // tolerate corrupt rows — events are best-effort observability data
      }
      const event: OrchestratorEvent = {
        ts: r.ts,
        sprintId: r.sprint_id as SprintId,
        kind: r.kind,
        payload,
      };
      if (r.task_id !== null) event.taskId = r.task_id as TaskId;
      if (r.worker_id !== null) event.workerId = r.worker_id as WorkerId;
      return event;
    });
  }

  recordAttempt(input: AttemptRecordInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO attempts (task_id, worker_id, started_at, ended_at, exit_code, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.workerId,
        input.startedAt,
        input.endedAt ?? null,
        input.exitCode ?? null,
        input.error ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  saveRateLimit(snapshot: RateLimitSnapshot & { tokensLimit: number }): void {
    this.db
      .prepare(
        `INSERT INTO rate_limits
           (worker_id, tokens_remaining, tokens_limit, reset_at, pressure, observed_at)
         VALUES (@workerId, @tokensRemaining, @tokensLimit, @resetAt, @pressure, @observedAt)
         ON CONFLICT(worker_id) DO UPDATE SET
           tokens_remaining = excluded.tokens_remaining,
           tokens_limit = excluded.tokens_limit,
           reset_at = excluded.reset_at,
           pressure = excluded.pressure,
           observed_at = excluded.observed_at`,
      )
      .run(snapshot);
  }

  /**
   * Upsert the accumulated USD spend for a sprint. Called from the
   * SprintManager every time an attempt reports `total_cost_usd`, so PM2
   * restarts (or any other process churn) preserve the running total used
   * by the BUDGET_USD guard.
   */
  saveSprintSpend(sprintId: SprintId, spentUsd: number, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO sprint_runtime_state (sprint_id, spent_usd, rate_reset_at, updated_at)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT(sprint_id) DO UPDATE SET
           spent_usd = excluded.spent_usd,
           updated_at = excluded.updated_at`,
      )
      .run(sprintId, spentUsd, updatedAt);
  }

  /**
   * Upsert the rate-limit reset timestamp for a paused sprint, or clear it
   * by passing `null` once the window opens and the sprint is resumed.
   */
  saveSprintRateReset(
    sprintId: SprintId,
    resetAt: number | null,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO sprint_runtime_state (sprint_id, spent_usd, rate_reset_at, updated_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(sprint_id) DO UPDATE SET
           rate_reset_at = excluded.rate_reset_at,
           updated_at = excluded.updated_at`,
      )
      .run(sprintId, resetAt, updatedAt);
  }

  /**
   * Snapshot every persisted sprint-runtime row. Used by the SprintManager
   * constructor to rehydrate `sprintSpend` and `rateLimitResetAt` Maps in
   * one read after a restart.
   */
  loadAllSprintRuntime(): Map<SprintId, SprintRuntimeState> {
    const rows = this.db
      .prepare('SELECT * FROM sprint_runtime_state')
      .all() as ReadonlyArray<SprintRuntimeRow>;
    const out = new Map<SprintId, SprintRuntimeState>();
    for (const row of rows) {
      out.set(row.sprint_id as SprintId, {
        spentUsd: row.spent_usd,
        rateResetAt: row.rate_reset_at,
      });
    }
    return out;
  }

  latestPressure(workerId: WorkerId): RateLimitSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM rate_limits WHERE worker_id = ?')
      .get(workerId) as RateLimitRow | undefined;
    if (!row) return undefined;
    return {
      workerId: row.worker_id,
      tokensRemaining: row.tokens_remaining,
      resetAt: row.reset_at,
      pressure: row.pressure,
      observedAt: row.observed_at,
    };
  }

}
