import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { screenshotPaths, ensureScreenshotDirs } from '../screenshot.js';
import { parsePlaywrightReport } from '../playwright.js';

describe('screenshotPaths', () => {
  it('returns baselines/diffs/report paths anchored at worktree', () => {
    const wt = '/tmp/wt';
    const paths = screenshotPaths(wt);
    // Compare via resolve() so the assertion uses the OS path separator and
    // root-handling rules (screenshotPaths itself is path.resolve-based).
    expect(paths.baselinesDir).toBe(resolve(wt, '.omc-screenshots/baselines'));
    expect(paths.diffsDir).toBe(resolve(wt, '.omc-screenshots/diffs'));
    expect(paths.reportPath).toBe(resolve(wt, '.omc-screenshots/report.json'));
  });

  it('ensureScreenshotDirs creates the baselines and diffs directories', () => {
    const wt = mkdtempSync(join(tmpdir(), 'omc-ss-'));
    const paths = ensureScreenshotDirs(wt);
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(paths.baselinesDir)).toBe(true);
    expect(existsSync(paths.diffsDir)).toBe(true);
  });
});

describe('parsePlaywrightReport', () => {
  it('returns empty summary on malformed JSON', () => {
    const summary = parsePlaywrightReport('not json');
    expect(summary.totalSpecs).toBe(0);
    expect(summary.failedSpecs).toHaveLength(0);
  });

  it('collects failed specs with screenshot attachments', () => {
    const report = JSON.stringify({
      suites: [
        {
          file: 'home.spec.ts',
          specs: [
            {
              title: 'renders hero',
              file: 'home.spec.ts',
              ok: false,
              tests: [
                {
                  results: [
                    {
                      status: 'failed',
                      attachments: [
                        {
                          name: 'screenshot',
                          path: '/tmp/diff.png',
                          contentType: 'image/png',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            { title: 'passes', ok: true, file: 'home.spec.ts', tests: [] },
          ],
        },
      ],
    });

    const summary = parsePlaywrightReport(report);
    expect(summary.totalSpecs).toBe(2);
    expect(summary.failedSpecs).toHaveLength(1);
    expect(summary.failedSpecs[0]?.title).toBe('renders hero');
    expect(summary.screenshots).toContain('/tmp/diff.png');
  });
});
