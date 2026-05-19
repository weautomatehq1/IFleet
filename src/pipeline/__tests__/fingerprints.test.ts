import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachFix,
  computeFingerprint,
  formatPriorFixHint,
  loadFingerprints,
  matchFingerprint,
  recordFingerprint,
  saveFingerprints,
  type FingerprintStore,
} from '../fingerprints.js';

const SAMPLE_TS_LOG = `
> tsc --noEmit
src/foo/bar.ts:42:5 - error TS2322: Type 'string' is not assignable to type 'number'.
    at compile (/Users/alice/repo/dist/compiler.js:120:10)
    at run (/Users/alice/repo/dist/run.js:55:3)
    at main (/Users/alice/repo/dist/index.js:9:1)
`.trim();

// Same logical failure on a different machine — different absolute paths,
// different line numbers, but same root cause.
const SAMPLE_TS_LOG_MOVED = `
> tsc --noEmit
src/foo/bar.ts:99:1 - error TS2322: Type 'string' is not assignable to type 'number'.
    at compile (/home/bob/work/dist/compiler.js:300:99)
    at run (/home/bob/work/dist/run.js:200:1)
    at main (/home/bob/work/dist/index.js:5:5)
`.trim();

const UNRELATED_LOG = `
TypeError: Cannot read properties of undefined (reading 'forEach')
    at handler (/repo/dist/server.js:11:1)
`.trim();

describe('computeFingerprint', () => {
  it('is deterministic — same input → same hash', () => {
    const a = computeFingerprint(SAMPLE_TS_LOG);
    const b = computeFingerprint(SAMPLE_TS_LOG);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(16);
  });

  it('strips absolute paths and line numbers so equivalent failures collide', () => {
    const a = computeFingerprint(SAMPLE_TS_LOG);
    const b = computeFingerprint(SAMPLE_TS_LOG_MOVED);
    expect(a.hash).toBe(b.hash);
    expect(a.tag).toMatch(/tsc:/);
  });

  it('produces different hashes for genuinely different failures', () => {
    const a = computeFingerprint(SAMPLE_TS_LOG);
    const b = computeFingerprint(UNRELATED_LOG);
    expect(a.hash).not.toBe(b.hash);
    expect(b.tag).toMatch(/TypeError/);
  });

  it('handles empty input without throwing', () => {
    const { hash, tag } = computeFingerprint('');
    expect(hash).toHaveLength(16);
    expect(tag).toBe('unknown');
  });
});

describe('store ops', () => {
  it('records new fingerprints and increments on repeat', () => {
    const store: FingerprintStore = {};
    const fixed = new Date('2026-05-18T00:00:00.000Z');
    recordFingerprint(store, 'abc', 'tsc: type mismatch', fixed);
    recordFingerprint(store, 'abc', 'tsc: type mismatch', new Date());
    const entry = store['abc'];
    expect(entry).toBeDefined();
    expect(entry?.count).toBe(2);
    expect(entry?.first_seen).toBe(fixed.toISOString());
  });

  it('attachFix sets last_fix_commit and is a no-op on unknown hashes', () => {
    const store: FingerprintStore = {};
    recordFingerprint(store, 'abc', 'tag');
    attachFix(store, 'abc', 'deadbeef');
    attachFix(store, 'missing', 'nope');
    expect(store['abc']?.last_fix_commit).toBe('deadbeef');
    expect(store['missing']).toBeUndefined();
  });

  it('matchFingerprint returns the prior entry or undefined', () => {
    const store: FingerprintStore = {};
    recordFingerprint(store, 'abc', 'tag');
    expect(matchFingerprint(store, 'abc')?.count).toBe(1);
    expect(matchFingerprint(store, 'xyz')).toBeUndefined();
  });
});

describe('load/save round-trip', () => {
  it('writes and re-reads identical content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fingerprints-'));
    const path = join(dir, '.omc/fingerprints.json');
    const store: FingerprintStore = {};
    recordFingerprint(store, 'abc', 'tag', new Date('2026-05-18T12:00:00.000Z'));
    attachFix(store, 'abc', 'cafef00d');
    saveFingerprints(path, store);
    const reloaded = loadFingerprints(path);
    expect(reloaded).toEqual(store);
    // Sanity: file is valid JSON.
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });

  it('loadFingerprints returns {} for missing or malformed files', () => {
    expect(loadFingerprints(join(tmpdir(), 'does-not-exist-fp.json'))).toEqual({});
  });
});

describe('formatPriorFixHint', () => {
  it('returns empty when no prior is given', () => {
    expect(formatPriorFixHint(undefined)).toBe('');
  });

  it('includes the fix commit when present', () => {
    const out = formatPriorFixHint({
      first_seen: '2026-05-18T12:00:00.000Z',
      count: 3,
      tag: 'tsc: type mismatch',
      last_fix_commit: 'deadbeef',
    });
    expect(out).toContain('seen 3x');
    expect(out).toContain('deadbeef');
    expect(out).toContain('tsc: type mismatch');
  });
});
