/**
 * Postgres connection pool for the knowledge graph.
 *
 * Decided per ADR-0003 + T2 brief: `pg` over `postgres.js` — battle-tested,
 * widely deployed, ships with type defs, and pgvector integrates by sending
 * the embedding as a `[1,2,3]`-style string cast to `vector`. No driver-side
 * vector library required for M3.W1.
 *
 * Connection string lives in `IFLEET_KG_DATABASE_URL`. The pool is created
 * lazily so importing this module doesn't require the env var (lets us run
 * the typecheck and parser unit tests without Postgres).
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';

let cachedPool: Pool | undefined;

export class KgPostgresUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KgPostgresUnavailableError';
  }
}

/**
 * Resolve the env var and build a pool. Caches between calls in the same
 * process. Pass `overrideUrl` in tests when pointing at a throwaway db.
 */
export function getKgPool(overrideUrl?: string): Pool {
  if (cachedPool) return cachedPool;
  const url = overrideUrl ?? process.env.IFLEET_KG_DATABASE_URL;
  if (!url) {
    throw new KgPostgresUnavailableError(
      'IFLEET_KG_DATABASE_URL is not set. Either copy .env.example to .env and ' +
        'fill the Supabase connection string (auto-loaded by CLI scripts) OR ' +
        'export the value in your shell before invoking. ADR-0003 has the ' +
        'project name: ifleet-kg.',
    );
  }
  const config: PoolConfig = {
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Supabase direct connection requires TLS; node-postgres needs the explicit hint
    // because the URL alone doesn't enable SSL by default.
    ssl: url.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
  };
  cachedPool = new Pool(config);
  return cachedPool;
}

/** Test-only: drop the cached pool. */
export async function resetKgPool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = undefined;
  }
}

export async function withKgClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getKgPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Encode a JS number[] as the pgvector text literal: `[0.1,0.2,...]`.
 * The driver sends this as text and Postgres casts it via the `vector` type.
 * Throws if any value is NaN or non-finite to prevent silent pgvector syntax errors.
 */
export function encodeVector(values: ReadonlyArray<number>): string {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`encodeVector: value at index ${i} is not finite (${values[i]})`);
    }
  }
  return '[' + values.join(',') + ']';
}
