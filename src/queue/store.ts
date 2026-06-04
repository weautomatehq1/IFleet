import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { QueuedTask, TaskState } from '../contracts/task.js';
import { DiscordOutbox } from '../observability/discord-outbox.js';

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
  fingerprint TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_decisions_task_pr
  ON pr_decisions(task_id, pr_number);

-- Nonce ledger — persistent HMAC-replay protection for the control plane.
-- See createNonceLedger() below and src/queue/control-plane.ts NonceLedger.
-- Persisted to survive PM2 restart (AUDIT-IFleet-e664f9f3).
CREATE TABLE IF NOT EXISTS nonce_ledger (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonce_ledger_expires ON nonce_ledger(expires_at);

-- Discord outbox — durable queue for Discord broadcasts.
-- Enqueued before every broadcastIFleet send; drained every 30s by the
-- Orchestrator. Dead-letters after maxAttempts failures instead of silently
-- dropping. Closes AUDIT-IFleet-77ddf58c.
CREATE TABLE IF NOT EXISTS discord_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_discord_outbox_pending
  ON discord_outbox(state, created_at)
  WHERE state = 'pending';
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
  attempts: number;
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
  /** Structural diff hash (M4). Null when not yet computed. */
  fingerprint?: string | null;
}

/**
 * Inputs for `insertPrDecisionWithFingerprint`: the M4 variant of
 * `recordPrDecision` that lets the caller supply both the row id and the
 * fingerprint. Callers are SprintManager/T3 — they own the id so the same row
 * can be referenced before and after CI completes.
 */
export interface InsertPrDecisionWithFingerprintInput {
  id: string;
  taskId: string;
  repo: string;
  prNumber: number;
  verdict: PrVerdict;
  reviewerLogin?: string | null;
  mergedAt?: number | null;
  fingerprint?: string | null;
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
  fingerprint: string | null;
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
    // attempts column: tracks how many times recoverStale() reset this task.
    // Once attempts >= MAX_ATTEMPTS the task is marked failed instead of
    // re-queued, preventing infinite retry loops on permanently-failing tasks
    // (AUDIT-IFleet-942cd45c).
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: attempts/i.test(message)) throw err;
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
        fingerprint TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
      CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_decisions_task_pr
        ON pr_decisions(task_id, pr_number);
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
            fingerprint TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_pr_decisions_repo ON pr_decisions(repo);
          CREATE INDEX IF NOT EXISTS idx_pr_decisions_task ON pr_decisions(task_id);
        `);
      }
    }
    // M4 upgrade: add fingerprint column to DBs created before this migration.
    // PRAGMA table_info → no-op when the column already exists (fresh DBs from
    // SCHEMA or from the recreate path above). Nullable — historical rows stay
    // NULL.
    const cols = this.db.pragma('table_info(pr_decisions)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'fingerprint')) {
      this.db.exec(`ALTER TABLE pr_decisions ADD COLUMN fingerprint TEXT`);
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

  // TaskStore state machine — DO NOT confuse with the orchestrator's
  // StateStore (src/orchestrator/store.ts) which uses kind: 'pending' |
  // 'running' | 'completed' | 'cancelled' | 'paused'. They are different
  // tables for different lifecycles.
  //
  //   TaskStore.state values (TaskState in src/contracts/task.ts):
  //     'pending'    — created, not yet picked up
  //     'in_flight'  — pickNext() set this; picked_at is the wall-clock pick
  //     'done'       — completed successfully
  //     'failed'     — terminal failure
  //     'blocked'    — needs operator attention (HITL)
  //
  // pickNext() atomically claims the task inside BEGIN IMMEDIATE so two
  // control-plane processes sharing the SQLite file cannot both observe the
  // same row as 'pending' (AUDIT-IFleet-de355093). recoverStale() resets any
  // 'in_flight' row whose picked_at is older than maxAgeMs back to 'pending'.
  // The two share the 'pending' / 'in_flight' vocabulary on purpose.
  pickNext(filter: PickFilter = {}): QueuedTask | null {
    const params: Record<string, unknown> = {};
    let selectSql = `SELECT * FROM tasks WHERE state = 'pending'`;
    if (filter.repo) {
      selectSql += ' AND repo = @repo';
      params['repo'] = filter.repo;
    }
    selectSql += ` ORDER BY ${PRIORITY_ORDER_SQL}, created_at ASC LIMIT 1`;

    const now = Date.now();
    const claimFn = this.db.transaction(() => {
      const row = this.db.prepare(selectSql).get(params) as TaskRow | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `UPDATE tasks SET state = 'in_flight', picked_at = @now, state_meta = NULL WHERE id = @id AND state = 'pending'`,
        )
        .run({ now, id: row.id });
      if (result.changes !== 1) return null;
      return { ...row, state: 'in_flight', picked_at: now } as TaskRow;
    });

    const claimed = claimFn.immediate() as TaskRow | null;
    return claimed ? rowToTask(claimed) : null;
  }

  /**
   * Reset any `in_flight` task whose `picked_at` is older than `maxAgeMs`
   * back to `pending` so the next `pickNext` re-issues it. Defaults to 30
   * minutes — call once at server boot to recover from a crash that left
   * tasks orphaned mid-run. Returns the number of rows reset.
   *
   * State machine: only 'in_flight' rows are eligible. 'done' / 'failed' /
   * 'blocked' are terminal-ish and untouched. 'pending' rows already are
   * waiting so they're skipped. This is intentionally narrower than
   * pickNext() which only consumes 'pending'.
   */
  recoverStale(maxAgeMs: number = DEFAULT_STALE_MS): number {
    const maxAttempts = Number(process.env['IFLEET_MAX_ATTEMPTS'] ?? 5);
    const cutoff = Date.now() - maxAgeMs;
    const now = Date.now();
    // Both UPDATEs run in a single transaction so a concurrent pickNext() cannot
    // observe the intermediate state where a task is pending but has attempts >= maxAttempts.
    const runRecovery = this.db.transaction(() => {
      // Tasks that have hit the attempt cap are marked failed to prevent infinite
      // retry loops on permanently-failing tasks (AUDIT-IFleet-942cd45c).
      const failedResult = this.db
        .prepare(
          `UPDATE tasks
              SET state = 'failed',
                  state_meta = json_object('reason', 'max-attempts', 'attempts', attempts, 'failed_at', @now),
                  completed_at = @now
            WHERE state = 'in_flight'
              AND picked_at IS NOT NULL
              AND picked_at < @cutoff
              AND attempts >= @maxAttempts`,
        )
        .run({ now, cutoff, maxAttempts });
      // Remaining stale tasks (below cap) are reset to pending with incremented attempts.
      const recoveredResult = this.db
        .prepare(
          `UPDATE tasks
              SET state = 'pending',
                  state_meta = json_object('recovered_at', @now, 'previous_state', 'in_flight'),
                  picked_at = NULL,
                  attempts = attempts + 1
            WHERE state = 'in_flight'
              AND picked_at IS NOT NULL
              AND picked_at < @cutoff`,
        )
        .run({ now, cutoff });
      return failedResult.changes + recoveredResult.changes;
    });
    return runRecovery() as number;
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
   * Idempotent on (task_id, pr_number): a second call for the same pair is a
   * no-op and returns the existing row. Both wireSprintCompletion (in
   * src/orchestrator/daemon.ts) and UnifiedQueueAdapter can fire on the same
   * sprint completion under retry/restart, so the dedup is enforced by the
   * UNIQUE constraint on (task_id, pr_number).
   */
  recordPrDecision(input: RecordPrDecisionInput): PrDecision {
    const id = `prd_${randomUUID()}`;
    const createdAt = Date.now();
    const reviewerLogin = input.reviewerLogin ?? null;
    const mergedAt = input.mergedAt ?? null;
    const fingerprint = input.fingerprint ?? null;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_decisions
            (id, task_id, repo, pr_number, verdict, reviewer_login, merged_at, created_at, fingerprint)
         VALUES (@id, @task_id, @repo, @pr_number, @verdict, @reviewer_login, @merged_at, @created_at, @fingerprint)`,
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
        fingerprint,
      });

    const row = this.getPrDecisionByTaskPr(input.taskId, input.prNumber);
    if (!row) {
      throw new Error(
        `pr_decisions row missing after INSERT for task ${input.taskId} pr ${input.prNumber}`,
      );
    }
    return row;
  }

  /**
   * M4 variant. Caller supplies the row id (so the same row id flows from
   * SprintManager into RecordPrDecision events) and may supply a structural
   * fingerprint computed via `computeStructuralFingerprint`. Idempotent on
   * (task_id, pr_number) — a second call for the same pair returns the
   * existing row unchanged.
   */
  insertPrDecisionWithFingerprint(input: InsertPrDecisionWithFingerprintInput): PrDecision {
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_decisions
            (id, task_id, repo, pr_number, verdict, reviewer_login, merged_at, created_at, fingerprint)
         VALUES (@id, @task_id, @repo, @pr_number, @verdict, @reviewer_login, @merged_at, @created_at, @fingerprint)`,
      )
      .run({
        id: input.id,
        task_id: input.taskId,
        repo: input.repo,
        pr_number: input.prNumber,
        verdict: input.verdict,
        reviewer_login: input.reviewerLogin ?? null,
        merged_at: input.mergedAt ?? null,
        created_at: createdAt,
        fingerprint: input.fingerprint ?? null,
      });
    const row = this.getPrDecisionByTaskPr(input.taskId, input.prNumber);
    if (!row) {
      throw new Error(
        `pr_decisions row missing after INSERT for task ${input.taskId} pr ${input.prNumber}`,
      );
    }
    return row;
  }

  /** Look up an existing PR decision for the (taskId, prNumber) pair. */
  getPrDecisionByTaskPr(taskId: string, prNumber: number): PrDecision | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pr_decisions WHERE task_id = @task_id AND pr_number = @pr_number LIMIT 1`,
      )
      .get({ task_id: taskId, pr_number: prNumber }) as
      | {
          id: string;
          task_id: string;
          repo: string;
          pr_number: number;
          verdict: string;
          reviewer_login: string | null;
          merged_at: number | null;
          created_at: number;
          fingerprint: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      repo: row.repo,
      prNumber: row.pr_number,
      verdict: row.verdict as PrDecision['verdict'],
      reviewerLogin: row.reviewer_login,
      mergedAt: row.merged_at,
      createdAt: row.created_at,
      fingerprint: row.fingerprint,
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
        fingerprint: string | null;
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
      fingerprint: r.fingerprint,
    }));
  }

  /**
   * Idempotently seed a stub task row for a synthetic `backfill:<url>` task_id.
   * The `pr_decisions` table has an FK onto `tasks.id`, so the backfill script
   * must call this before `recordPrDecision` on a fresh DB (AUDIT-IFleet-31181042).
   * `INSERT OR IGNORE` makes repeated calls safe.
   */
  ensureBackfillTaskStub(taskId: string, repo: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tasks
            (id, source_kind, source_data, repo, brief, title, routing_hints,
             state, idempotency_key, created_at)
         VALUES (@id, 'backfill', '{}', @repo, 'backfill stub', 'backfill stub',
                 '{}', 'done', @id, @created_at)`,
      )
      .run({ id: taskId, repo, created_at: Date.now() });
  }

  /**
   * Return a SQLite-backed nonce ledger that shares this store's DB handle.
   * The ledger survives control-plane restarts so a captured signed request
   * cannot be replayed inside the maxSkewSec window after PM2 restart
   * (AUDIT-IFleet-e664f9f3). `ttlMs` should be `(maxSkewSec + padding) * 1000`.
   */
  createNonceLedger(ttlMs: number): SqliteNonceLedger {
    return new SqliteNonceLedger(this.db, ttlMs);
  }

  /** Return a Discord outbox backed by this store's DB handle. */
  createDiscordOutbox(): DiscordOutbox {
    return new DiscordOutbox(this.db);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Persistent nonce ledger used by the control plane to reject replayed
 * signed requests. Stored in the `nonce_ledger` table on the shared
 * tasks DB so the record survives a control-plane restart.
 *
 * `registerOrReject` opportunistically prunes expired rows on every call;
 * a periodic sweep is unnecessary because the per-insert prune bounds the
 * table size at the count of nonces signed within the TTL window.
 *
 * The prune + INSERT OR IGNORE pair runs inside a `BEGIN IMMEDIATE`
 * transaction (better-sqlite3 `txn.immediate(...)`) so two control-plane
 * processes racing on the same SQLite file cannot both observe the nonce
 * as fresh: the IMMEDIATE lock serialises writers and `result.changes === 1`
 * IS the atomic decision (AUDIT-IFleet-cf106efc).
 */
export class SqliteNonceLedger {
  private readonly insertStmt: Database.Statement<{ nonce: string; expires_at: number }>;
  private readonly pruneStmt: Database.Statement<{ now: number }>;
  private readonly registerTxn: Database.Transaction<
    (args: { nonce: string; now: number; expires_at: number }) => boolean
  >;

  constructor(
    private readonly db: Database.Database,
    private readonly ttlMs: number,
  ) {
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO nonce_ledger (nonce, expires_at) VALUES (@nonce, @expires_at)`,
    );
    this.pruneStmt = this.db.prepare(`DELETE FROM nonce_ledger WHERE expires_at <= @now`);
    this.registerTxn = this.db.transaction(
      ({ nonce, now, expires_at }: { nonce: string; now: number; expires_at: number }) => {
        this.pruneStmt.run({ now });
        const result = this.insertStmt.run({ nonce, expires_at });
        return result.changes === 1;
      },
    );
  }

  /** Returns true if the nonce was fresh and is now recorded. False if already seen. */
  registerOrReject(nonce: string, now: number = Date.now()): boolean {
    return this.registerTxn.immediate({ nonce, now, expires_at: now + this.ttlMs });
  }

  /** No-op: no timers or async resources to release. Kept for interface parity with in-memory ledger. */
  destroy(): void {
    // intentionally empty
  }

  /** Test helper — number of rows currently in the ledger. */
  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM nonce_ledger`).get() as { n: number };
    return row.n;
  }
}


function normalizePriority(value: unknown): 'low' | 'normal' | 'high' {
  if (value === 'high' || value === 'low' || value === 'normal') return value;
  return 'normal';
}

function safeJsonParse(raw: string, fallback: unknown, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] JSON.parse failed for ${label}:`, err);
    return fallback;
  }
}

function rowToTask(row: TaskRow): QueuedTask {
  return {
    id: row.id,
    source: safeJsonParse(row.source_data, { kind: 'unknown' }, `task ${row.id} source_data`) as QueuedTask['source'],
    repo: row.repo,
    brief: row.brief,
    title: row.title,
    routingHints: safeJsonParse(row.routing_hints, {}, `task ${row.id} routing_hints`) as QueuedTask['routingHints'],
    createdAt: row.created_at,
    idempotencyKey: row.idempotency_key,
    state: row.state as TaskState,
    stateMeta: row.state_meta
      ? (safeJsonParse(row.state_meta, undefined, `task ${row.id} state_meta`) as Record<string, unknown> | undefined)
      : undefined,
  };
}
