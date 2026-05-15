import { describe, expect, it } from 'vitest';
import { migrateReposConfig } from '../repos.js';

describe('migrateReposConfig', () => {
  it('migrates legacy { repos: [...] } format to map keyed by owner/name', () => {
    const legacy = { repos: [{ owner: 'weautomatehq1', name: 'IFleet' }] };
    const result = migrateReposConfig(legacy);
    expect(result).toEqual({
      'weautomatehq1/IFleet': { owner: 'weautomatehq1', name: 'IFleet' },
    });
  });

  it('is idempotent — new format passes through unchanged', () => {
    const newFormat = {
      'weautomatehq1/IFleet': { owner: 'weautomatehq1', name: 'IFleet' },
    };
    const result = migrateReposConfig(newFormat);
    expect(result).toEqual(newFormat);
  });

  it('migrates multi-repo legacy config preserving all entries', () => {
    const legacy = {
      repos: [
        { owner: 'org1', name: 'repo-a' },
        { owner: 'org2', name: 'repo-b' },
      ],
    };
    const result = migrateReposConfig(legacy);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['org1/repo-a']).toEqual({ owner: 'org1', name: 'repo-a' });
    expect(result['org2/repo-b']).toEqual({ owner: 'org2', name: 'repo-b' });
  });

  it('throws on unrecognised format', () => {
    expect(() => migrateReposConfig({ something: 'weird' })).toThrow();
  });

  it('default repo key is weautomatehq1/IFleet after migration', () => {
    const legacy = { repos: [{ owner: 'weautomatehq1', name: 'IFleet' }] };
    const result = migrateReposConfig(legacy);
    expect('weautomatehq1/IFleet' in result).toBe(true);
  });

  it('preserves allowedAuthors in the new map format', () => {
    const newFormat = {
      'weautomatehq1/IFleet': {
        owner: 'weautomatehq1',
        name: 'IFleet',
        allowedAuthors: ['alice', 'bob'],
      },
    };
    const result = migrateReposConfig(newFormat);
    expect(result['weautomatehq1/IFleet']?.allowedAuthors).toEqual(['alice', 'bob']);
  });

  it('rejects allowedAuthors that is not a string array', () => {
    const bad = {
      'a/b': { owner: 'a', name: 'b', allowedAuthors: [1, 2] },
    };
    expect(() => migrateReposConfig(bad)).toThrow();
  });
});
