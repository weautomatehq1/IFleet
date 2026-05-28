import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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

CREATE TABLE IF NOT EXISTS pr_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  reviewer_login TEXT,
  merged_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
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

export type PrVerdict = 'merged' | 'rejected' | 'abandoned';

export interface RecordPrDecisionInput {
  taskId: string;
  repo: string;
  prNumber: number;
  verdict: PrVerdict;
  /** GitHub login of the reviewer; null when no review data is available. */
  reviewerLogin?: string | null;
  /** Unix timestamp (ms) when the PR was merged; omit for non-merged verdicts. */
  mergedAt?: number;
}


export interface PrDecision {
  id: string;
  taskId: string;
  repo: string;
  prNumber: number;
  verdict: PrVerdict;
  reviewerLogin: string | null;
  mergedAt: number | null;
  createdAt: number;
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(path: string = defaultTasksDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
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
    // pr_decisions table was added later; SCHEMA creates it on fresh DBs, this
    // migration covers existing DBs that pre-date the table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        reviewer_login TEXT,
        merged_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
      CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
    `);
    // Forward-compat: if an older DB already created pr_decisions WITHOUT the
    // task_id FK, recreate it. Safe because pr_decisions was dead code until
    // M4 — nothing wrote to it. If somehow non-empty, keep the data and skip
    // the recreate; the row will be FK-less but writes will still succeed.
    const fkList = this.db.pragma('foreign_key_list(pr_decisions)') as Array<{ from: string }>;
    const hasTaskFk = fkList.some((row) => row.from === 'task_id');
    if (!hasTaskFk) {
      const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM pr_decisions`).get() as { n: number };
      if (n === 0) {
        this.db.exec(`
          DROP TABLE pr_decisions;
          CREATE TABLE pr_decisions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            repo TEXT NOT NULL,
            pr_number INTEGER NOT NULL,
            verdict TEXT NOT NULL,
            reviewer_login TEXT,
            merged_at INTEGER,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
          CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
        `);
      }
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

  patchSource(taskId: string, source: QueuedTask['source']): void {
    this.db
      .prepare(`UPDATE tasks SET source_data = @source_data WHERE id = @id`)
      .run({ id: taskId, source_data: JSON.stringify(source) });
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

  /**
   * Record the final disposition of a PR that was opened during a sprint.
   * Idempotent on (task_id, pr_number) — a second call for the same pair
   * will throw a UNIQUE constraint if the table ever gains that constraint;
   * for now callers are responsible for not double-writing.
   */
  recordPrDecision(input: RecordPrDecisionInput): PrDecision {
    const id = `prd_${randomUUID()}`;
    const createdAt = Date.now();
    const reviewerLogin = input.reviewerLogin ?? null;
    const mergedAt = input.mergedAt ?? null;

    this.db
      .prepare(
        `INSERT INTO pr_decisions (id, task_id, repo, pr_number, verdict, reviewer_login, merged_at, created_at)
         VALUES (@id, @task_id, @repo, @pr_number, @verdict, @reviewer_login, @merged_at, @created_at)`,
      )
      .run({
        id,
        task_id: input.taskId,
        repo: input.repo,
        pr_number: input.prNumber,
        verdict: input.verdict,
        reviewer_login: reviewerLogin,
        merged_at: mergedAt,
        created_at: createdAt,
      });

    return {
      id,
      taskId: input.taskId,
      repo: input.repo,
      prNumber: input.prNumber,
      verdict: input.verdict,
      reviewerLogin,
      mergedAt,
      createdAt,
    };
  }

  /** Fetch all PR decisions for a repo, newest first. */
  getPrDecisionsByRepo(repo: string, limit = 100): PrDecision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pr_decisions WHERE repo = @repo ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({ repo, limit }) as Array<{
        id: string;
        task_id: string;
        repo: string;
        pr_number: number;
        verdict: string;
        reviewer_login: string | null;
        merged_at: number | null;
        created_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      repo: r.repo,
      prNumber: r.pr_number,
      verdict: r.verdict as PrVerdict,
      reviewerLogin: r.reviewer_login,
      mergedAt: r.merged_at,
      createdAt: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}


function normalizePriority(value: unknown): 'low' | 'normal' | 'high' {
  if (value === 'high' || value === 'low' || value === 'normal') return value;
  return 'normal';
}

const VALID_TASK_STATES: ReadonlySet<string> = new Set([
  'pending',
  'in_flight',
  'done',
  'failed',
  'blocked',
]);

function rowToTask(row: TaskRow): QueuedTask {
  let source: QueuedTask['source'];
  try {
    source = JSON.parse(row.source_data);
  } catch (err) {
    throw new Error(`rowToTask: corrupt source_data for task ${row.id}: ${String(err)}`);
  }
  let routingHints: QueuedTask['routingHints'];
  try {
    routingHints = JSON.parse(row.routing_hints);
  } catch (err) {
    throw new Error(`rowToTask: corrupt routing_hints for task ${row.id}: ${String(err)}`);
  }
  let stateMeta: QueuedTask['stateMeta'];
  if (row.state_meta) {
    try {
      stateMeta = JSON.parse(row.state_meta);
    } catch {
      stateMeta = undefined;
    }
  }
  if (!VALID_TASK_STATES.has(row.state)) {
    throw new Error(`rowToTask: invalid state ${JSON.stringify(row.state)} for task ${row.id}`);
  }
  return {
    id: row.id,
    source,
    repo: row.repo,
    brief: row.brief,
    title: row.title,
    routingHints,
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
    state: row.state as TaskState,
    stateMeta,
  };
}
