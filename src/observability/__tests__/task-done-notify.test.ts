import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as https from 'node:https';
import * as cp from 'node:child_process';
import { postTaskDoneNotification } from '../task-done-notify.js';

vi.mock('node:https');
vi.mock('node:child_process');

function makeHttpsMock(statusCode = 200) {
  const res = { resume: vi.fn(), on: vi.fn((ev, cb) => { if (ev === 'end') cb(); }) };
  const req = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  vi.mocked(https.request).mockImplementation((_opts, cb) => {
    (cb as (r: typeof res) => void)(res);
    return req as unknown as ReturnType<typeof https.request>;
  });
  return { req, res };
}

function makeSpawnMock(stdout: string, exitCode = 0) {
  const proc = {
    stdout: { on: vi.fn((ev, cb) => { if (ev === 'data') cb(stdout); }) },
    stderr: { on: vi.fn() },
    on: vi.fn((ev, cb) => { if (ev === 'close') cb(exitCode); }),
  };
  vi.mocked(cp.spawn).mockReturnValue(proc as unknown as ReturnType<typeof cp.spawn>);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('postTaskDoneNotification', () => {
  it('spawns claude to generate summary then posts to webhook', async () => {
    const { req } = makeHttpsMock();
    makeSpawnMock('IFleet just finished teaching itself to route tasks by label.');

    await postTaskDoneNotification({
      taskId: '42',
      prUrl: 'https://github.com/weautomatehq1/IFleet/pull/72',
      brief: 'Fix classifier sprint mode routing',
      webhookUrl: 'https://discord.com/api/webhooks/test/token',
      claudePath: 'claude',
    });

    // claude was called with -p flag
    expect(cp.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p']),
      expect.any(Object),
    );
    // webhook was called
    expect(https.request).toHaveBeenCalled();
    const rawArg = vi.mocked(req.write).mock.calls[0]?.[0];
    const body = JSON.parse(rawArg as string) as { content: string };
    expect(body.content).toContain('https://github.com/weautomatehq1/IFleet/pull/72');
    expect(body.content).toContain('IFleet just finished');
  });

  it('is a no-op when prUrl is absent', async () => {
    makeSpawnMock('');
    await postTaskDoneNotification({
      taskId: '42',
      prUrl: undefined,
      brief: 'something',
      webhookUrl: 'https://discord.com/api/webhooks/test/token',
      claudePath: 'claude',
    });
    expect(cp.spawn).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it('is a no-op when webhookUrl is absent', async () => {
    makeSpawnMock('');
    await postTaskDoneNotification({
      taskId: '42',
      prUrl: 'https://github.com/weautomatehq1/IFleet/pull/72',
      brief: 'something',
      webhookUrl: undefined,
      claudePath: 'claude',
    });
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it('swallows discord post errors without throwing', async () => {
    makeSpawnMock('some summary');
    const req = { write: vi.fn(), end: vi.fn(), on: vi.fn((ev, cb) => { if (ev === 'error') cb(new Error('network')); }) };
    vi.mocked(https.request).mockReturnValue(req as unknown as ReturnType<typeof https.request>);

    await expect(
      postTaskDoneNotification({
        taskId: '42',
        prUrl: 'https://github.com/weautomatehq1/IFleet/pull/72',
        brief: 'something',
        webhookUrl: 'https://discord.com/api/webhooks/test/token',
        claudePath: 'claude',
      }),
    ).resolves.not.toThrow();
  });

  it('swallows claude spawn errors without throwing', async () => {
    makeHttpsMock();
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((ev, cb) => { if (ev === 'error') cb(new Error('spawn fail')); }),
    };
    vi.mocked(cp.spawn).mockReturnValue(proc as unknown as ReturnType<typeof cp.spawn>);

    await expect(
      postTaskDoneNotification({
        taskId: '42',
        prUrl: 'https://github.com/weautomatehq1/IFleet/pull/72',
        brief: 'something',
        webhookUrl: 'https://discord.com/api/webhooks/test/token',
        claudePath: 'claude',
      }),
    ).resolves.not.toThrow();
  });
});
