import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess, verifyChildEnv } from './spawn-util.js';
import { loadVerifyConfig } from './config-loader.js';
import { hasPlaywrightConfig, parsePlaywrightReport } from './playwright.js';
import type { VerifyConfig, VerifyKindResult } from './types.js';

export interface ScreenshotPaths {
  baselinesDir: string;
  diffsDir: string;
  reportPath: string;
}

export function screenshotPaths(worktreePath: string): ScreenshotPaths {
  return {
    baselinesDir: resolve(worktreePath, '.omc-screenshots/baselines'),
    diffsDir: resolve(worktreePath, '.omc-screenshots/diffs'),
    reportPath: resolve(worktreePath, '.omc-screenshots/report.json'),
  };
}

export function ensureScreenshotDirs(worktreePath: string): ScreenshotPaths {
  const paths = screenshotPaths(worktreePath);
  for (const dir of [paths.baselinesDir, paths.diffsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export async function runScreenshotDiff(
  worktreePath: string,
  config?: VerifyConfig,
): Promise<VerifyKindResult> {
  if (!hasPlaywrightConfig(worktreePath)) {
    return {
      ok: false,
      durationMs: 0,
      output: '[screenshot] requires Playwright config (toHaveScreenshot is a Playwright API)',
    };
  }
  const cfg = config ?? loadVerifyConfig(worktreePath);
  const paths = ensureScreenshotDirs(worktreePath);
  const firstRun = !existsSync(resolve(paths.baselinesDir, '.initialized'));

  // Allowlisted child env + the screenshot-specific (non-secret) vars; never
  // spread the full `process.env` into a worktree-script subprocess.
  const env: NodeJS.ProcessEnv = verifyChildEnv(process.env, {
    PLAYWRIGHT_JSON_OUTPUT_NAME: paths.reportPath,
    OMC_SCREENSHOT_THRESHOLD: String(cfg.screenshot.threshold),
    OMC_SCREENSHOT_MAX_DIFF_PIXELS: String(cfg.screenshot.maxDiffPixels),
  });

  const args = ['playwright', 'test', '--reporter=json'];
  if (firstRun) args.push('--update-snapshots');

  const result = await runProcess('npx', args, {
    cwd: worktreePath,
    timeoutMs: cfg.timeouts.screenshot,
    env,
  });

  if (firstRun) {
    try {
      mkdirSync(paths.baselinesDir, { recursive: true });
      const initFile = resolve(paths.baselinesDir, '.initialized');
      // Mark baselines as initialized for next run
      const { writeFileSync } = await import('node:fs');
      writeFileSync(initFile, new Date().toISOString());
    } catch {
      /* non-fatal */
    }
  }

  const summary = parsePlaywrightReport(result.output);
  const failedScreenshots = summary.failedSpecs.length;
  const output =
    `[screenshot] firstRun=${firstRun} threshold=${cfg.screenshot.threshold} ` +
    `maxDiffPixels=${cfg.screenshot.maxDiffPixels} failedSpecs=${failedScreenshots}\n` +
    result.output;

  return {
    ok: result.ok && failedScreenshots === 0,
    durationMs: result.durationMs,
    output,
  };
}
