import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { runDriftScan } from '../scan.js';

function makePool(rows: Array<{
  repo_id: string;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
}>): Pool {
  return {
    query: vi.fn(async () => ({ rowCount: rows.length, rows })),
  } as unknown as Pool;
}

const FIXED_NOW = () => new Date('2026-06-16T03:00:00Z');

describe('runDriftScan', () => {
  it('returns an empty result when fewer than 2 repos are provided', async () => {
    const warn = vi.fn();
    const result = await runDriftScan({ repos: ['only-one'], now: FIXED_NOW, warn });
    expect(result.candidates).toHaveLength(0);
    expect(result.symbolsCompared).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/needs ≥2 repos/));
  });

  it('aggregates the comparator output with summary counts and sorted reposScanned', async () => {
    const pool = makePool([
      { repo_id: 'repoA', path: 'src/createUser.ts', name: 'createUser', kind: 'function', signature: 'function createUser(x: A): User' },
      { repo_id: 'repoB', path: 'src/createUser.ts', name: 'createUser', kind: 'function', signature: 'function createUser(x: B): User' },
      { repo_id: 'repoA', path: 'src/helper.ts', name: 'helperX', kind: 'function', signature: 'function helperX(): void' },
      { repo_id: 'repoB', path: 'src/helper.ts', name: 'helperX', kind: 'function', signature: 'function helperX(): void' },
    ]);
    const result = await runDriftScan({
      repos: ['repoB', 'repoA', 'repoC'],
      pool,
      now: FIXED_NOW,
    });
    expect(result.reposScanned).toEqual(['repoA', 'repoB', 'repoC']);
    expect(result.symbolsCompared).toBe(4);
    expect(result.candidates.some((c) => c.driftKind === 'signature_skew')).toBe(true);
    expect(result.candidates.some((c) => c.driftKind === 'rename_or_deletion')).toBe(true);
    expect(result.summary.signature_skew).toBeGreaterThanOrEqual(1);
    expect(result.summary.rename_or_deletion).toBeGreaterThanOrEqual(1);
    expect(result.scannedAt).toBe('2026-06-16T03:00:00.000Z');
  });

  it('returns empty result + warns when the pool throws', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    } as unknown as Pool;
    const warn = vi.fn();
    const result = await runDriftScan({
      repos: ['repoA', 'repoB'],
      pool,
      warn,
      now: FIXED_NOW,
    });
    expect(result.candidates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loadObservations failed/));
  });
});
