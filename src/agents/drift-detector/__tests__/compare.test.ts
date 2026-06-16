import { describe, expect, it } from 'vitest';

import { compareDrift } from '../compare.js';
import type { SymbolObservation } from '../types.js';

function obs(
  repoId: string,
  name: string,
  signature: string | null,
  kind: SymbolObservation['kind'] = 'function',
  path = `src/${name}.ts`,
): SymbolObservation {
  return { repoId, path, name, signature, kind };
}

describe('compareDrift — signature_skew', () => {
  it('flags two distinct signatures across two repos', () => {
    const out = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
        obs('repoB', 'createUser', 'function createUser(x: B): User'),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    const skew = out.find((c) => c.driftKind === 'signature_skew');
    expect(skew).toBeDefined();
    expect(skew!.symbolKey).toBe('function:createUser');
    expect(skew!.groups).toHaveLength(2);
    expect(skew!.outlierRepos).toEqual(['repoB']);
  });

  it('picks the majority signature as group[0] and lists outliers correctly', () => {
    const out = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
        obs('repoB', 'createUser', 'function createUser(x: A): User'),
        obs('repoC', 'createUser', 'function createUser(x: A): User'),
        obs('repoD', 'createUser', 'function createUser(x: B): User'),
      ],
      { peerRepos: ['repoA', 'repoB', 'repoC', 'repoD'] },
    );
    const skew = out.find((c) => c.driftKind === 'signature_skew')!;
    expect(skew.groups[0]!.signature).toContain(': A)');
    expect(skew.groups[0]!.repos).toEqual(['repoA', 'repoB', 'repoC']);
    expect(skew.outlierRepos).toEqual(['repoD']);
  });

  it('does not flag a single null signature alongside a real one (null is "unknown", not drift)', () => {
    const out = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(): User'),
        obs('repoB', 'createUser', null),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    expect(out.some((c) => c.driftKind === 'signature_skew')).toBe(false);
  });

  it('does not flag identical signatures across repos', () => {
    const out = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(): User'),
        obs('repoB', 'createUser', 'function createUser(): User'),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    expect(out.some((c) => c.driftKind === 'signature_skew')).toBe(false);
  });
});

describe('compareDrift — rename_or_deletion', () => {
  it('flags absence of a symbol in some peer repos', () => {
    const out = compareDrift(
      [
        obs('repoA', 'helperX', 'function helperX(): void'),
        obs('repoB', 'helperX', 'function helperX(): void'),
      ],
      { peerRepos: ['repoA', 'repoB', 'repoC'] },
    );
    const renamed = out.find((c) => c.driftKind === 'rename_or_deletion');
    expect(renamed).toBeDefined();
    expect(renamed!.outlierRepos).toEqual(['repoC']);
    expect(renamed!.groups[0]!.signature).toBe('present');
    expect(renamed!.groups[1]!.signature).toBe('absent');
  });

  it('does NOT fire when peerRepos is empty', () => {
    const out = compareDrift(
      [
        obs('repoA', 'helperX', 'function helperX(): void'),
        obs('repoB', 'helperX', 'function helperX(): void'),
      ],
      { peerRepos: [] },
    );
    expect(out.some((c) => c.driftKind === 'rename_or_deletion')).toBe(false);
  });

  it('does NOT fire when symbol is present in every peer repo', () => {
    const out = compareDrift(
      [
        obs('repoA', 'helperX', 'function helperX(): void'),
        obs('repoB', 'helperX', 'function helperX(): void'),
        obs('repoC', 'helperX', 'function helperX(): void'),
      ],
      { peerRepos: ['repoA', 'repoB', 'repoC'] },
    );
    expect(out.some((c) => c.driftKind === 'rename_or_deletion')).toBe(false);
  });
});

describe('compareDrift — determinism', () => {
  it('produces stable output for the same input bytes-for-bytes (order independent)', () => {
    const a = compareDrift(
      [
        obs('repoB', 'createUser', 'function createUser(x: B): User'),
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    const b = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
        obs('repoB', 'createUser', 'function createUser(x: B): User'),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('respects kind: same-name symbols of different kinds are not conflated', () => {
    const out = compareDrift(
      [
        obs('repoA', 'User', 'class User { id: string }', 'class'),
        obs('repoB', 'User', 'type User = { id: string }', 'type'),
      ],
      { peerRepos: ['repoA', 'repoB'] },
    );
    expect(out.filter((c) => c.driftKind === 'signature_skew')).toHaveLength(0);
  });

  it('respects minObservations: a one-shot symbol does not produce a candidate', () => {
    const out = compareDrift(
      [obs('repoA', 'soloUtil', 'function soloUtil(): void')],
      { peerRepos: ['repoA', 'repoB'] },
    );
    expect(out.filter((c) => c.driftKind === 'signature_skew')).toHaveLength(0);
  });

  it('orders candidates with the same symbolKey by driftKind, regardless of input order', () => {
    // createUser drift across A+B with distinct signatures + absent in peer C
    // → emits BOTH signature_skew AND rename_or_deletion under the same key.
    const reverse = compareDrift(
      [
        obs('repoB', 'createUser', 'function createUser(x: B): User'),
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
      ],
      { peerRepos: ['repoA', 'repoB', 'repoC'] },
    );
    const forward = compareDrift(
      [
        obs('repoA', 'createUser', 'function createUser(x: A): User'),
        obs('repoB', 'createUser', 'function createUser(x: B): User'),
      ],
      { peerRepos: ['repoA', 'repoB', 'repoC'] },
    );
    expect(reverse.map((c) => c.driftKind)).toEqual(forward.map((c) => c.driftKind));
    // driftKind sort is alphabetic: rename_or_deletion < signature_skew.
    expect(reverse.map((c) => c.driftKind)).toEqual([
      'rename_or_deletion',
      'signature_skew',
    ]);
  });
});
