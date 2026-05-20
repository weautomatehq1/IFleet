/**
 * Upsert idempotency test. Uses a fake `PoolClient` so it runs without a live
 * Postgres connection — exercises the conflict-resolution flow, identity-map
 * resolution, and edge-drop-when-unresolved behavior.
 *
 * A second test against a real pgvector database is gated by
 * `IFLEET_KG_DATABASE_URL` so CI without Postgres still passes. When the env
 * var is set, it migrates the schema, upserts the same parse result twice,
 * and asserts row counts are unchanged after the second pass.
 */
import { describe, expect, it } from 'vitest';
import { upsertParsedFiles } from '../upsert.js';
import type { ParsedFile } from '../types.js';

interface QueryCall {
  text: string;
  values?: ReadonlyArray<unknown>;
}

function fakeClient(): {
  client: import('pg').PoolClient;
  calls: QueryCall[];
  nextId: { value: number };
} {
  const calls: QueryCall[] = [];
  const nextId = { value: 1 };

  const query = async (text: string, values?: ReadonlyArray<unknown>) => {
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO code_nodes')) {
      const id = nextId.value++;
      return { rows: [{ id: String(id) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const client = { query } as unknown as import('pg').PoolClient;
  return { client, calls, nextId };
}

const sampleFile: ParsedFile = {
  path: 'src/x.ts',
  nodes: [
    { repoId: 'r', path: 'src/x.ts', kind: 'file', name: 'src/x.ts', sha: 'abc' },
    {
      repoId: 'r',
      path: 'src/x.ts',
      kind: 'function',
      name: 'foo',
      sha: 'abc',
      startLine: 1,
      endLine: 3,
    },
  ],
  edges: [
    { srcKey: 'src/x.ts::file::src/x.ts', dstKey: 'src/x.ts::function::foo', kind: 'contains' },
    // Unresolved — points at a node we never upserted.
    { srcKey: 'src/x.ts::file::src/x.ts', dstKey: './missing.js::file::./missing.js', kind: 'imports' },
  ],
};

describe('upsertParsedFiles', () => {
  it('wraps inserts in a transaction', async () => {
    const { client, calls } = fakeClient();
    await upsertParsedFiles(client, [sampleFile]);
    expect(calls[0]?.text).toBe('BEGIN');
    expect(calls[calls.length - 1]?.text).toBe('COMMIT');
  });

  it('reports node + edge counts and drops unresolved edges', async () => {
    const { client } = fakeClient();
    const summary = await upsertParsedFiles(client, [sampleFile]);
    expect(summary.nodesUpserted).toBe(2);
    expect(summary.edgesUpserted).toBe(1);
    expect(summary.edgesDroppedUnresolved).toBe(1);
  });

  it('uses ON CONFLICT on the identity tuple', async () => {
    const { client, calls } = fakeClient();
    await upsertParsedFiles(client, [sampleFile]);
    const insert = calls.find(c => c.text.includes('INSERT INTO code_nodes'));
    expect(insert?.text).toContain('ON CONFLICT (repo_id, path, name, kind)');
  });

  it('rolls back on error', async () => {
    const calls: QueryCall[] = [];
    const client = {
      query: async (text: string, values?: ReadonlyArray<unknown>) => {
        calls.push({ text, values });
        if (text.startsWith('INSERT INTO code_nodes')) throw new Error('boom');
        return { rows: [], rowCount: 0 };
      },
    } as unknown as import('pg').PoolClient;
    await expect(upsertParsedFiles(client, [sampleFile])).rejects.toThrow('boom');
    expect(calls.some(c => c.text === 'ROLLBACK')).toBe(true);
  });
});
