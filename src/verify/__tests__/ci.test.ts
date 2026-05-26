import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runCiKind } from '../ci.js';
import { EventEmitter } from 'node:events';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('runCiKind', () => {
  it('invokes pnpm run <script> with the worktree as cwd and no shell', async () => {
    const child = createFakeChild();
    spawnMock.mockImplementation((cmd: string, args: string[], opts: { cwd: string; shell: boolean }) => {
      expect(cmd).toBe('pnpm');
      expect(args.slice(0, 3)).toEqual(['run', 'typecheck', '--silent']);
      expect(opts.cwd).toBe('/tmp/wt');
      expect(opts.shell).toBe(false);
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('ok\n'));
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await runCiKind('/tmp/wt', 'typecheck');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure when exit code is non-zero', async () => {
    const child = createFakeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('boom\n'));
        child.emit('close', 1, null);
      });
      return child;
    });

    const result = await runCiKind('/tmp/wt', 'lint');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('boom');
  });

  it('marks timeout when the kill timer fires before close', async () => {
    const child = createFakeChild();
    spawnMock.mockImplementation(() => {
      // Simulate kill -> close
      child.kill = vi.fn(() => {
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      });
      return child;
    });

    const result = await runCiKind('/tmp/wt', 'test', {
      screenshot: { maxDiffPixels: 50, threshold: 0.2 },
      timeouts: { typecheck: 1, lint: 1, test: 1, playwright: 1, playwrightBootstrap: 5000, screenshot: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timeout/);
  });
});
