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
      console.warn(`loadSprint: corrupt state_json for sprint ${row.id}: ${String(err)}`);
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
      console.warn(`loadTask: corrupt state_json for task ${row.id}: ${String(err)}`);
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
    const rows = this.db
      .prepare('SELECT * FROM sprints')
      .all() as ReadonlyArray<SprintRow>;
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
