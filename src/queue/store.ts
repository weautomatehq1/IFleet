import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { QueuedTask, TaskState } from '../contracts/task.js';

export function defaultStateDir(): string {
  return process.env['IFLEET_STATE_DIR'] ?? join(process.cwd(), 'state');
}

export function defaultTasksDbPath(): string {
  return join(defaultStateDir(), 'tasks.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_data TEXT NOT NULL,
  repo TEXT NOT NULL,
  brief TEXT NOT NULL,
  title TEXT NOT NULL,
  routing_hints TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  state_meta TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  picked_at INTEGER,
  completed_at INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
`;

const PRIORITY_ORDER_SQL =
  "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END";

const DEFAULT_STALE_MS = 30 * 60 * 1000;

interface TaskRow {
  id: string;
  source_kind: string;
  source_data: string;
  repo: string;
  brief: string;
  title: string;
  routing_hints: string;
  state: string;
  state_meta: string | null;
  idempotency_key: string;
  created_at: number;
  picked_at: number | null;
  completed_at: number | null;
  priority: string;
}

export interface ListFilter {
  source?: 'github' | 'discord';
  state?: TaskState;
  channelId?: string;
  repo?: string;
}

export interface PickFilter {
  repo?: string;
}

export interface InsertResult {
  inserted: boolean;
  existing?: QueuedTask;
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(path: string = defaultTasksDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Forward-compatible migration: CREATE TABLE IF NOT EXISTS above creates
    // the column on fresh dbs; this ALTER catches dbs created before HIGH-4.
    // SQLite errors if the column already exists — swallow that specific
    // case, surface anything else.
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: priority/i.test(message)) throw err;
    }
  }

  insert(task: QueuedTask): InsertResult {
    const existing = this.findByIdempotencyKey(task.idempotencyKey);
    if (existing) return { inserted: false, existing };

    const priority = normalizePriority(task.routingHints?.priority);
    this.db
      .prepare(
        `INSERT INTO tasks (id, source_kind, source_data, repo, brief, title, routing_hints,
                            state, state_meta, idempotency_key, created_at, priority)
         VALUES (@id, @source_kind, @source_data, @repo, @brief, @title, @routing_hints,
                 @state, @state_meta, @idempotency_key, @created_at, @priority)`,
      )
      .run({
        id: task.id,
        source_kind: task.source.kind,
        source_data: JSON.stringify(task.source),
        repo: task.repo,
        brief: task.brief,
        title: task.title,
        routing_hints: JSON.stringify(task.routingHints),
        state: task.state ?? 'pending',
        state_meta: task.stateMeta ? JSON.stringify(task.stateMeta) : null,
        idempotency_key: task.idempotencyKey,
        created_at: task.createdAt,
        priority,
      });
    return { inserted: true };
  }

  pickNext(filter: PickFilter = {}): QueuedTask | null {
    const params: Record<string, unknown> = {};
    let sql = `SELECT * FROM tasks WHERE state = 'pending'`;
    if (filter.repo) {
      sql += ' AND repo = @repo';
      params['repo'] = filter.repo;
    }
    sql += ` ORDER BY ${PRIORITY_ORDER_SQL}, created_at ASC LIMIT 1`;
    const row = this.db.prepare(sql).get(params) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Reset any `in_flight` task whose `picked_at` is older than `maxAgeMs`
   * back to `pending` so the next `pickNext` re-issues it. Defaults to 30
   * minutes — call once at server boot to recover from a crash that left
   * tasks orphaned mid-run. Returns the number of rows reset.
   */
  recoverStale(maxAgeMs: number = DEFAULT_STALE_MS): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare(
        `UPDATE tasks
            SET state = 'pending',
                state_meta = json_object('recovered_at', @now, 'previous_state', 'in_flight'),
                picked_at = NULL
          WHERE state = 'in_flight'
            AND picked_at IS NOT NULL
            AND picked_at < @cutoff`,
      )
      .run({ now: Date.now(), cutoff });
    return result.changes;
  }

  updateState(taskId: string, state: TaskState, meta?: Record<string, unknown>): void {
    const now = Date.now();
    const stamps: Record<string, unknown> = {};
    if (state === 'in_flight') stamps['picked_at'] = now;
    if (state === 'done' || state === 'failed') stamps['completed_at'] = now;

    const setParts = ['state = @state', 'state_meta = @state_meta'];
    const params: Record<string, unknown> = {
      id: taskId,
      state,
      state_meta: meta ? JSON.stringify(meta) : null,
      ...stamps,
    };
    if ('picked_at' in stamps) setParts.push('picked_at = @picked_at');
    if ('completed_at' in stamps) setParts.push('completed_at = @completed_at');
    this.db.prepare(`UPDATE tasks SET ${setParts.join(', ')} WHERE id = @id`).run(params);
  }

  getById(taskId: string): QueuedTask | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findByIdempotencyKey(key: string): QueuedTask | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
      .get(key) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  list(filter: ListFilter = {}, limit = 100): QueuedTask[] {
    const wheres: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (filter.source) {
      wheres.push('source_kind = @source');
      params['source'] = filter.source;
    }
    if (filter.state) {
      wheres.push('state = @state');
      params['state'] = filter.state;
    }
    if (filter.repo) {
      wheres.push('repo = @repo');
      params['repo'] = filter.repo;
    }
    if (filter.channelId) {
      // Discord-source filter via JSON extraction.
      wheres.push(`json_extract(source_data, '$.channelId') = @channel`);
      params['channel'] = filter.channelId;
    }
    const where = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC LIMIT @limit`)
      .all(params) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Test/diagnostic helper. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function normalizePriority(value: unknown): 'low' | 'normal' | 'high' {
  if (value === 'high' || value === 'low' || value === 'normal') return value;
  return 'normal';
}

function rowToTask(row: TaskRow): QueuedTask {
  return {
    id: row.id,
    source: JSON.parse(row.source_data),
    repo: row.repo,
    brief: row.brief,
    title: row.title,
    routingHints: JSON.parse(row.routing_hints),
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
    state: row.state as TaskState,
    stateMeta: row.state_meta ? JSON.parse(row.state_meta) : undefined,
  };
}
