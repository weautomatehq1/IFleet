import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChannelRouter } from '../router.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ifleet-router-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeChannels(obj: unknown): string {
  const path = join(tmp, 'channels.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const validChannel = {
  channelId: '1504120127791042631',
  name: 'ifleet',
  repo: 'weautomatehq1/IFleet',
  defaultBranch: 'main',
  defaultModel: 'opus',
  allowedUserIds: ['1503477896402960405'],
  codeowners: ['@monstersebas1'],
};

describe('FileChannelRouter.fromFile', () => {
  it('loads and resolves a valid mapping', () => {
    const path = writeChannels({ version: 1, channels: [validChannel] });
    const router = FileChannelRouter.fromFile(path, { reposDir: '/var/r' });
    const route = router.resolve('1504120127791042631');
    expect(route).not.toBeNull();
    expect(route!.repo).toBe('weautomatehq1/IFleet');
    expect(route!.workDir).toBe('/var/r/weautomatehq1-IFleet');
    expect(route!.defaultModel).toBe('opus');
    expect(route!.allowedUserIds).toEqual(['1503477896402960405']);
  });

  it('returns null for unknown channels', () => {
    const path = writeChannels({ version: 1, channels: [validChannel] });
    const router = FileChannelRouter.fromFile(path, { reposDir: '/var/r' });
    expect(router.resolve('999999999999999999')).toBeNull();
  });

  it('list() returns a defensive copy', () => {
    const path = writeChannels({ version: 1, channels: [validChannel] });
    const router = FileChannelRouter.fromFile(path, { reposDir: '/var/r' });
    const list = router.list();
    list.pop();
    expect(router.list()).toHaveLength(1);
  });

  it('rejects unsupported version', () => {
    const path = writeChannels({ version: 2, channels: [] });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/unsupported version/);
  });

  it('rejects duplicate channelId', () => {
    const path = writeChannels({
      version: 1,
      channels: [validChannel, { ...validChannel, name: 'dup' }],
    });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/duplicate channelId/);
  });

  it('rejects malformed repo string', () => {
    const path = writeChannels({
      version: 1,
      channels: [{ ...validChannel, repo: 'not-a-repo' }],
    });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/owner\/name/);
  });

  it('rejects unknown defaultModel', () => {
    const path = writeChannels({
      version: 1,
      channels: [{ ...validChannel, defaultModel: 'gpt' }],
    });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/defaultModel/);
  });

  it('rejects empty allowedUserIds', () => {
    const path = writeChannels({
      version: 1,
      channels: [{ ...validChannel, allowedUserIds: [] }],
    });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/allowedUserIds/);
  });

  it('rejects non-snowflake channelId', () => {
    const path = writeChannels({
      version: 1,
      channels: [{ ...validChannel, channelId: 'abc' }],
    });
    expect(() => FileChannelRouter.fromFile(path)).toThrow(/snowflake/);
  });

  it('honors IFLEET_REPOS_DIR env when no opts override', () => {
    const path = writeChannels({ version: 1, channels: [validChannel] });
    const prev = process.env['IFLEET_REPOS_DIR'];
    process.env['IFLEET_REPOS_DIR'] = '/srv/x';
    try {
      const router = FileChannelRouter.fromFile(path);
      expect(router.list()[0]!.workDir).toBe('/srv/x/weautomatehq1-IFleet');
    } finally {
      if (prev === undefined) delete process.env['IFLEET_REPOS_DIR'];
      else process.env['IFLEET_REPOS_DIR'] = prev;
    }
  });
});
