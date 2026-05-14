import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerifyRunner } from '../runner.js';
import type { VerifyKind } from '../types.js';

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

function makeWorktree(): string {
  return mkdtempSync(join(tmpdir(), 'omc-runner-'));
}

function writePlaywrightConfig(worktree: string): void {
  writeFileSync(join(worktree, 'playwright.config.ts'), 'export default {};');
}

interface ScriptResult {
  exitCode: number;
  stderr?: string;
  stdout?: string;
}

/**
 * Drive the spawn mock with a queue of (cmd, args) → exit code mappings.
 * Each spawn call consumes one entry. Asserts the queue is exhausted at the
 * end so tests fail loudly if the runner ran more kinds than expected.
 */
function driveSpawn(scripts: ScriptResult[]): { remaining: () => number } {
  const queue = [...scripts];
  spawnMock.mockImplementation(() => {
    const next = queue.shift();
    const child = createFakeChild();
    setImmediate(() => {
      if (next?.stderr) child.stderr.emit('data', Buffer.from(next.stderr));
      if (next?.stdout) child.stdout.emit('data', Buffer.from(next.stdout));
      child.emit('close', next?.exitCode ?? 0, null);
    });
    return child;
  });
  return { remaining: () => queue.length };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('createVerifyRunner gate completeness', () => {
  it('returns ok=true only when every requested kind passes', async () => {
    const wt = makeWorktree();
    driveSpawn([
      { exitCode: 0, stdout: 'tc-ok' },
      { exitCode: 0, stdout: 'lint-ok' },
      { exitCode: 0, stdout: 'test-ok' },
    ]);

    const runner = createVerifyRunner();
    const result = await runner.run(wt, ['typecheck', 'lint', 'test']);

    expect(result.ok).toBe(true);
    expect(result.perKind.typecheck.ok).toBe(true);
    expect(result.perKind.lint.ok).toBe(true);
    expect(result.perKind.test.ok).toBe(true);
  });

  it.each<VerifyKind>(['typecheck', 'lint', 'test'])(
    'fails the whole gate when only %s fails',
    async (failing) => {
      const wt = makeWorktree();
      const kinds: VerifyKind[] = ['typecheck', 'lint', 'test'];
      driveSpawn(
        kinds.map((k) => ({
          exitCode: k === failing ? 1 : 0,
          stderr: k === failing ? `${k}-boom` : '',
        })),
      );

      const runner = createVerifyRunner();
      const result = await runner.run(wt, kinds);

      expect(result.ok).toBe(false);
      expect(result.perKind[failing].ok).toBe(false);
      expect(result.perKind[failing].output).toContain(`${failing}-boom`);
      for (const k of kinds.filter((x) => x !== failing)) {
        expect(result.perKind[k].ok).toBe(true);
      }
    },
  );

  it('marks playwright failure as gate failure when requested', async () => {
    const wt = makeWorktree();
    writePlaywrightConfig(wt);
    driveSpawn([
      // playwright run: non-zero exit
      { exitCode: 1, stdout: 'not json' },
    ]);

    const runner = createVerifyRunner();
    const result = await runner.run(wt, ['playwright']);

    expect(result.ok).toBe(false);
    expect(result.perKind.playwright.ok).toBe(false);
  });

  it('skips kinds that are not requested', async () => {
    const wt = makeWorktree();
    const sentinel = driveSpawn([{ exitCode: 0, stdout: 'tc-ok' }]);

    const runner = createVerifyRunner();
    const result = await runner.run(wt, ['typecheck']);

    expect(result.ok).toBe(true);
    expect(result.perKind.typecheck.ok).toBe(true);
    expect(result.perKind.lint.output).toContain('[skipped]');
    expect(result.perKind.test.output).toContain('[skipped]');
    expect(result.perKind.playwright.output).toContain('[skipped]');
    expect(result.perKind.screenshot.output).toContain('[skipped]');
    expect(sentinel.remaining()).toBe(0);
  });
});
