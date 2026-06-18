// SQLite-backed drift idempotency store tests. Exercises the wasEmitted /
// markEmitted contract against a fresh tmp-dir DB so the suite never
// touches the cron's real state file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriftIdempotencyStore } from '../idempotency-store.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'drift-emitted-test-'));
  dbPath = join(tmpDir, 'drift-emitted.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteDriftIdempotencyStore', () => {
  it('wasEmitted(unknown) → false on a fresh DB', () => {
    const store = new SqliteDriftIdempotencyStore(dbPath);
    try {
      expect(store.wasEmitted('a'.repeat(64))).toBe(false);
      expect(store.count()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('markEmitted then wasEmitted → true', () => {
    const store = new SqliteDriftIdempotencyStore(dbPath);
    try {
      const key = 'b'.repeat(64);
      store.markEmitted(key, { sourceRepo: 'weautomatehq1/IFleet' });
      expect(store.wasEmitted(key)).toBe(true);
      const row = store.get(key);
      expect(row?.source_repo).toBe('weautomatehq1/IFleet');
      expect(typeof row?.emitted_at).toBe('number');
    } finally {
      store.close();
    }
  });

  it('markEmitted is idempotent — second insert is a no-op', () => {
    const store = new SqliteDriftIdempotencyStore(dbPath);
    try {
      const key = 'c'.repeat(64);
      store.markEmitted(key, { sourceRepo: 'a/b', emittedAt: 1000 });
      store.markEmitted(key, { sourceRepo: 'x/y', emittedAt: 9999 });
      expect(store.count()).toBe(1);
      // INSERT OR IGNORE → first row wins; we never silently overwrite.
      const row = store.get(key);
      expect(row?.source_repo).toBe('a/b');
      expect(row?.emitted_at).toBe(1000);
    } finally {
      store.close();
    }
  });

  it('state survives close + reopen on the same path', () => {
    const key = 'd'.repeat(64);
    const first = new SqliteDriftIdempotencyStore(dbPath);
    first.markEmitted(key);
    first.close();

    const second = new SqliteDriftIdempotencyStore(dbPath);
    try {
      expect(second.wasEmitted(key)).toBe(true);
    } finally {
      second.close();
    }
  });
});
