import Database from 'better-sqlite3';

const OUTBOX_SCHEMA = `
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

export type OutboxState = 'pending' | 'sent' | 'failed';

export interface OutboxEntry {
  id: number;
  channel: string;
  payload: string;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  lastAttemptAt: number | null;
  sentAt: number | null;
}

export interface DrainOpts {
  send: (channel: string, payload: string) => Promise<void>;
  maxAttempts?: number;
  batch?: number;
}

export interface DrainResult {
  sent: number;
  retried: number;
  failed: number;
}

type OutboxRow = {
  id: number;
  channel: string;
  payload: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  last_attempt_at: number | null;
  sent_at: number | null;
};

/**
 * Durable Discord message outbox backed by SQLite.
 *
 * Rows are inserted as `pending` by `broadcastIFleet` before the fast-path
 * HTTP attempt. A background drain job (wired in `Orchestrator.start`) retries
 * any rows that are still `pending` after a transient failure. After
 * `maxAttempts` total failures the row is dead-lettered as `failed` so it
 * never silently disappears — operators can inspect via `deadLetterEntries()`.
 *
 * Closes AUDIT-IFleet-77ddf58c.
 */
export class DiscordOutbox {
  constructor(private readonly db: Database.Database) {
    db.exec(OUTBOX_SCHEMA);
  }

  enqueue(channel: string, payload: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO discord_outbox (channel, payload, state, created_at)
         VALUES (@channel, @payload, 'pending', @created_at)`,
      )
      .run({ channel, payload, created_at: Date.now() });
    return Number(res.lastInsertRowid);
  }

  markSent(id: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE discord_outbox
            SET state = 'sent', sent_at = @now, last_attempt_at = @now
          WHERE id = @id`,
      )
      .run({ now, id });
  }

  /**
   * Increment `attempts`, record `error`, and dead-letter the row if
   * `attempts + 1 >= maxAttempts`. Otherwise keeps state as `pending` so the
   * next drain cycle retries.
   */
  markAttemptFailed(id: number, error: string, maxAttempts = 5): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE discord_outbox
            SET attempts = attempts + 1,
                last_error = @error,
                last_attempt_at = @now,
                state = CASE WHEN attempts + 1 >= @maxAttempts THEN 'failed' ELSE 'pending' END
          WHERE id = @id`,
      )
      .run({ error, now, maxAttempts, id });
  }

  async drainOnce(opts: DrainOpts): Promise<DrainResult> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const batch = opts.batch ?? 20;

    const rows = this.db
      .prepare(
        `SELECT * FROM discord_outbox
          WHERE state = 'pending'
          ORDER BY created_at ASC
          LIMIT @batch`,
      )
      .all({ batch }) as OutboxRow[];

    let sent = 0;
    let retried = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await opts.send(row.channel, row.payload);
        this.markSent(row.id);
        sent++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const willFail = row.attempts + 1 >= maxAttempts;
        this.markAttemptFailed(row.id, error, maxAttempts);
        if (willFail) failed++;
        else retried++;
      }
    }

    return { sent, retried, failed };
  }

  deadLetterEntries(): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM discord_outbox WHERE state = 'failed' ORDER BY created_at DESC`,
      )
      .all() as OutboxRow[];

    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      payload: r.payload,
      state: r.state as OutboxState,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      lastAttemptAt: r.last_attempt_at,
      sentAt: r.sent_at,
    }));
  }
}
