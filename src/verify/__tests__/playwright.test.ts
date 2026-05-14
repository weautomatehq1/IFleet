import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ensureBrowsersInstalled,
  hasPlaywrightConfig,
  parsePlaywrightReport,
  runPlaywright,
} from '../playwright.js';

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
  return mkdtempSync(join(tmpdir(), 'omc-pw-'));
}

function writePlaywrightConfig(worktree: string): void {
  writeFileSync(join(worktree, 'playwright.config.ts'), 'export default {};');
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('hasPlaywrightConfig', () => {
  it('detects .ts / .js / .mjs configs', () => {
    const wt = makeWorktree();
    expect(hasPlaywrightConfig(wt)).toBe(false);
    writeFileSync(join(wt, 'playwright.config.mjs'), 'export default {};');
    expect(hasPlaywrightConfig(wt)).toBe(true);
  });
});

describe('ensureBrowsersInstalled', () => {
  it('runs npx playwright install when sentinel is missing and writes the sentinel on success', async () => {
    const wt = makeWorktree();
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('npx');
      expect(args.slice(0, 2)).toEqual(['playwright', 'install']);
      const child = createFakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('done\n'));
        child.emit('close', 0, null);
      });
      return child;
    });

    const r1 = await ensureBrowsersInstalled(wt, { timeoutMs: 5000 });
    expect(r1.installed).toBe(true);
    expect(r1.cached).toBe(false);
    expect(existsSync(resolve(wt, '.omc/.omc-playwright-installed'))).toBe(true);
  });

  it('skips the install (cached=true) when the sentinel already exists', async () => {
    const wt = makeWorktree();
    // Pre-create the sentinel.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(wt, '.omc'), { recursive: true });
    writeFileSync(resolve(wt, '.omc/.omc-playwright-installed'), 'pretend');

    spawnMock.mockImplementation(() => {
      throw new Error('spawn should not be called when sentinel exists');
    });

    const r = await ensureBrowsersInstalled(wt);
    expect(r.cached).toBe(true);
    expect(r.installed).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports timeout cleanly when install hangs past the configured budget', async () => {
    const wt = makeWorktree();
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      child.kill = vi.fn(() => {
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
      });
      return child;
    });

    const r = await ensureBrowsersInstalled(wt, { timeoutMs: 1 });
    expect(r.installed).toBe(false);
    expect(r.cached).toBe(false);
    expect(r.output).toMatch(/timeout/);
    expect(existsSync(resolve(wt, '.omc/.omc-playwright-installed'))).toBe(false);
  });
});

describe('runPlaywright integration', () => {
  it('skips test run when no playwright config is present', async () => {
    const wt = makeWorktree();
    const r = await runPlaywright(wt);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('no playwright.config');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('runs bootstrap then test and returns ok=true when both succeed (synthetic data-URL spec report)', async () => {
    const wt = makeWorktree();
    writePlaywrightConfig(wt);

    // Simulate the report that playwright would write for a deterministic
    // data-URL spec: one passing spec, zero failures.
    const fakeReport = JSON.stringify({
      suites: [
        {
          file: 'data-url.spec.ts',
          specs: [
            {
              title: 'renders inline html from data: URL',
              file: 'data-url.spec.ts',
              ok: true,
              tests: [{ results: [{ status: 'passed' }] }],
            },
          ],
        },
      ],
    });

    let call = 0;
    spawnMock.mockImplementation(() => {
      call += 1;
      const child = createFakeChild();
      setImmediate(() => {
        if (call === 1) {
          // bootstrap
          child.stdout.emit('data', Buffer.from('browsers installed\n'));
        } else {
          // playwright test: write the report file like the real runner.
          const reportPath = resolve(wt, '.omc-playwright-report.json');
          writeFileSync(reportPath, fakeReport);
          child.stdout.emit('data', Buffer.from('1 passed\n'));
        }
        child.emit('close', 0, null);
      });
      return child;
    });

    const result = await runPlaywright(wt);
    expect(result.ok).toBe(true);
    expect(result.bootstrap?.installed).toBe(true);
    expect(result.summary?.totalSpecs).toBe(1);
    expect(result.summary?.failedSpecs).toHaveLength(0);
  });

  it('survives a flaky-then-passed spec: parser respects spec.ok over raw test results', () => {
    // Flaky spec: first attempt failed, retry passed → playwright marks
    // spec.ok=true. parsePlaywrightReport must not flag it as failed.
    const report = JSON.stringify({
      suites: [
        {
          file: 'flaky.spec.ts',
          specs: [
            {
              title: 'flaky page',
              file: 'flaky.spec.ts',
              ok: true,
              tests: [
                {
                  results: [
                    { status: 'failed' },
                    { status: 'passed' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const summary = parsePlaywrightReport(report);
    expect(summary.totalSpecs).toBe(1);
    expect(summary.failedSpecs).toHaveLength(0);
  });

  it('reports failure cleanly when the test run itself hits the timeout', async () => {
    const wt = makeWorktree();
    writePlaywrightConfig(wt);

    let call = 0;
    spawnMock.mockImplementation(() => {
      call += 1;
      const child = createFakeChild();
      if (call === 1) {
        // bootstrap succeeds quickly
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('done\n'));
          child.emit('close', 0, null);
        });
      } else {
        // playwright test hangs → killed by timeout
        child.kill = vi.fn(() => {
          setImmediate(() => child.emit('close', null, 'SIGKILL'));
        });
      }
      return child;
    });

    const result = await runPlaywright(wt, {
      screenshot: { maxDiffPixels: 50, threshold: 0.2 },
      timeouts: { typecheck: 1, lint: 1, test: 1, playwright: 1, screenshot: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timeout/);
  });
});
