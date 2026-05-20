#!/usr/bin/env node
/**
 * Applies all `deploy/postgres/*.sql` files in lexicographic order against
 * `IFLEET_KG_DATABASE_URL`. Migrations are idempotent (every CREATE uses
 * IF NOT EXISTS) so re-running this script is safe and is the documented
 * way to bring a fresh database up to the M3 schema.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getKgPool } from '../../src/agents/indexer/pg-client.ts';

async function main(): Promise<void> {
  const dir = resolve('deploy/postgres');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.error(`No SQL files in ${dir}`);
    process.exitCode = 2;
    return;
  }
  const pool = getKgPool();
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8');
    console.error(`[graph:migrate] applying ${f}`);
    await pool.query(sql);
  }
  await pool.end();
  console.error('[graph:migrate] done');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
