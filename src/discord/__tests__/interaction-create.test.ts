import { describe, expect, it, vi } from 'vitest';
import {
  buildCommandFromButton,
  buildCommandFromSlash,
} from '../handlers/interaction-create.js';
import { parseCustomId, buildCustomId } from '../../contracts/discord-out.js';
import type { DiscordCommandSource } from '../../contracts/control-plane-client.js';

const ALLSTATE = '1503769258981589012';
const SOURCE: DiscordCommandSource = {
  kind: 'discord',
  channelId: ALLSTATE,
  userId: '111',
  userLabel: 'seb',
};

function makeSlash(name: string, opts: Record<string, string | null>): any {
  return {
    channelId: ALLSTATE,
    commandName: name,
    options: {
      getString: vi.fn((key: string, required?: boolean) => {
        const v = opts[key];
        if (v === undefined && required) throw new Error(`missing ${key}`);
        if (v === undefined) return null;
        return v;
      }),
    },
    user: { id: '111', username: 'seb' },
  };
}

describe('buildCommandFromSlash', () => {
  it('builds sprint_goal from /ship', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('ship', { prompt: 'add login page' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'sprint_goal',
      goal: 'add login page',
      repo: 'weautomatehq1/allstate',
      source: SOURCE,
    });
  });

  it('tags /plan as planOnly', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('plan', { prompt: 'design X' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toMatchObject({ type: 'sprint_goal', planOnly: true });
  });

  it('falls back to channel sentinel for /status without taskid', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('status', { taskid: null }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'status',
      taskId: `__channel__:${ALLSTATE}`,
      source: SOURCE,
    });
  });

  it('builds /cancel with reason', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('cancel', { taskid: 'T1' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'cancelled via discord',
      source: SOURCE,
    });
  });

  it('builds /approve', () => {
    const cmd = buildCommandFromSlash(
      makeSlash('approve', { taskid: 'T1' }),
      'weautomatehq1/allstate',
      SOURCE,
    );
    expect(cmd).toEqual({ type: 'approve', taskId: 'T1', source: SOURCE });
  });

  it('returns null on unknown command', () => {
    const cmd = buildCommandFromSlash(makeSlash('bogus', {}), 'r', SOURCE);
    expect(cmd).toBeNull();
  });
});

describe('button customId round-trip (T5 contract)', () => {
  it('parses approve:<taskId>', () => {
    expect(parseCustomId(buildCustomId('approve', 'TASK_1'))).toEqual({
      verb: 'approve',
      taskId: 'TASK_1',
    });
  });

  it('parses reject:<taskId>', () => {
    expect(parseCustomId('reject:abc-123')).toEqual({ verb: 'reject', taskId: 'abc-123' });
  });

  it('returns null on unknown verb', () => {
    expect(parseCustomId('zap:T1')).toBeNull();
  });

  it('returns null on missing taskId', () => {
    expect(parseCustomId('approve:')).toBeNull();
    expect(parseCustomId('approve')).toBeNull();
  });

  it('preserves task ids containing colons', () => {
    expect(parseCustomId('cancel:project:42')).toEqual({
      verb: 'cancel',
      taskId: 'project:42',
    });
  });
});

describe('buildCommandFromButton', () => {
  it('maps approve verb to approve command', () => {
    expect(buildCommandFromButton('approve', 'T1', SOURCE)).toEqual({
      type: 'approve',
      taskId: 'T1',
      source: SOURCE,
    });
  });

  it('maps reject verb to cancel with reject reason', () => {
    expect(buildCommandFromButton('reject', 'T1', SOURCE)).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'rejected via discord',
      source: SOURCE,
    });
  });

  it('maps cancel verb to cancel with cancel reason', () => {
    expect(buildCommandFromButton('cancel', 'T1', SOURCE)).toEqual({
      type: 'cancel',
      taskId: 'T1',
      reason: 'cancelled via discord',
      source: SOURCE,
    });
  });
});
