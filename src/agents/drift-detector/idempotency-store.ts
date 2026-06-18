// M6 drift-detector idempotency store.
//
// Backs the `DRIFT_REAL_PR` cron path: every plan handed to the emitter
// gets its `idempotencyKey` recorded here, so a re-run that produces the
// same drift signature is a no-op (we never open the same drift PR twice).
//
// SQLite-backed for the same reason `src/queue/store.ts` is — the cron
// fires on a PM2 cron_restart, so dedup state must survive a process
// restart. The DB lives at `${defaultStateDir()}/drift-emitted.db` (a
// sibling of `tasks.db`) so the queue store and the drift store have
// independent file handles and can't interfere on schema migrations.
//
// The interface is deliberately tiny — `wasEmitted` / `markEmitted` /
// `close` — and matches the `DriftIdempotencyStore` type the cron injects,
// so tests can pass an in-memory Map-backed fake without touching SQLite.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultStateDir } from '../../queue/store.js';

/**
 * Default DB path for the drift idempotency store. Sibling of
 * `tasks.db` under whichever directory `IFLEET_STATE_DIR` (or the
 * cwd-relative default) resolves to.
 */
export function defaultDriftEmittedDbPath(): string {
  return join(defaultStateDir(), 'drift-emitted.db');
}

/**
 * Minimal interface the drift cron depends on. Two methods — `wasEmitted`
 * (read) and `markEmitted` (write) — plus `close` for the production path.
 * Tests pass an in-memory fake; production passes a SqliteDriftIdempotencyStore.
 */
export interface DriftIdempotencyStore {
  wasEmitted(key: string): boolean;
  markEmitted(key: string, meta?: { sourceRepo?: string; emittedAt?: number }): void;
  close?(): void;
}

interface DriftEmittedRow {
  idempotency_key: string;
  source_repo: string | null;
  emitted_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drift_emitted (
  idempotency_key TEXT PRIMARY KEY,
  source_repo TEXT,
  emitted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_emitted_emitted_at
  ON drift_emitted(emitted_at);
`;

/**
 * SQLite-backed dedupe store for emitted drift PRs. Persisted across PM2
 * restarts so the next cron tick can recognise a drift signature it has
 * already handed to the emitter and skip it.
 *
 * Same `ALTER TABLE`-on-instantiate pattern as `TaskStore`, so adding
 * columns later is a forward-compatible migration: append a guarded
 * `ALTER TABLE drift_emitted ADD COLUMN ...` after the `db.exec(SCHEMA)`.
 */
export class SqliteDriftIdempotencyStore implements DriftIdempotencyStore {
  private readonly db: Database.Database;

  constructor(path: string = defaultDriftEmittedDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  wasEmitted(key: string): boolean {
    const row = this.db
      .prepare(`SELECT idempotency_key FROM drift_emitted WHERE idempotency_key = ? LIMIT 1`)
      .get(key) as { idempotency_key: string } | undefined;
    return row !== undefined;
  }

  markEmitted(
    key: string,
    meta: { sourceRepo?: string; emittedAt?: number } = {},
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO drift_emitted (idempotency_key, source_repo, emitted_at)
         VALUES (@key, @source_repo, @emitted_at)`,
      )
      .run({
        key,
        source_repo: meta.sourceRepo ?? null,
        emitted_at: meta.emittedAt ?? Date.now(),
      });
  }

  /** Test/diagnostic helper — number of rows currently tracked. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM drift_emitted`).get() as { n: number };
    return row.n;
  }

  /** Test helper — return the row for inspection. */
  get(key: string): DriftEmittedRow | null {
    const row = this.db
      .prepare(`SELECT * FROM drift_emitted WHERE idempotency_key = ? LIMIT 1`)
      .get(key) as DriftEmittedRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}
