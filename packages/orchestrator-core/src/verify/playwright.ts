import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess, verifyChildEnv } from './spawn-util.js';
import { loadVerifyConfig } from './config-loader.js';
import type { VerifyConfig, VerifyKindResult } from './types.js';

const BROWSER_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BROWSER_INSTALL_SENTINEL = '.omc-playwright-installed';

interface PlaywrightSpec {
  title: string;
  file?: string;
  ok: boolean;
  attachments?: Array<{ name: string; path?: string; contentType?: string }>;
}

interface PlaywrightSummary {
  totalSpecs: number;
  failedSpecs: PlaywrightSpec[];
  screenshots: string[];
}

interface RawSuite {
  title?: string;
  file?: string;
  suites?: RawSuite[];
  specs?: RawSpec[];
}

interface RawSpec {
  title?: string;
  file?: string;
  ok?: boolean;
  tests?: Array<{
    results?: Array<{
      status?: string;
      attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
    }>;
  }>;
}

export function hasPlaywrightConfig(worktreePath: string): boolean {
  const candidates = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'];
  return candidates.some((name) => existsSync(resolve(worktreePath, name)));
}

export interface BootstrapResult {
  installed: boolean;
  cached: boolean;
  durationMs: number;
  output: string;
}

/**
 * Idempotently install Playwright browsers. Writes a sentinel under
 * `.omc/` so subsequent runs in the same worktree skip the (~30s) install.
 * The sentinel is intentionally per-worktree, not per-machine — a fresh
 * worktree should always confirm browsers are present, since `~/.cache`
 * can be cleared independently.
 */
export async function ensureBrowsersInstalled(
  worktreePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<BootstrapResult> {
  const omcDir = resolve(worktreePath, '.omc');
  const sentinel = resolve(omcDir, BROWSER_INSTALL_SENTINEL);
  if (existsSync(sentinel)) {
    return { installed: false, cached: true, durationMs: 0, output: '[bootstrap] cached' };
  }
  const timeoutMs = opts.timeoutMs ?? BROWSER_INSTALL_TIMEOUT_MS;
  const result = await runProcess('npx', ['playwright', 'install', '--with-deps=false'], {
    cwd: worktreePath,
    timeoutMs,
  });
  if (result.ok) {
    try {
      mkdirSync(omcDir, { recursive: true });
      writeFileSync(sentinel, new Date().toISOString());
    } catch {
      /* sentinel is best-effort; next call will retry the install */
    }
  }
  return {
    installed: result.ok,
    cached: false,
    durationMs: result.durationMs,
    output: result.output,
  };
}

export function parsePlaywrightReport(json: string): PlaywrightSummary {
  let parsed: { suites?: RawSuite[] };
  try {
    parsed = JSON.parse(json) as { suites?: RawSuite[] };
  } catch {
    return { totalSpecs: 0, failedSpecs: [], screenshots: [] };
  }

  const failedSpecs: PlaywrightSpec[] = [];
  const screenshots: string[] = [];
  let totalSpecs = 0;

  const walk = (suite: RawSuite): void => {
    for (const spec of suite.specs ?? []) {
      totalSpecs += 1;
      const ok = spec.ok ?? true;
      if (!ok) {
        const attachments: PlaywrightSpec['attachments'] = [];
        for (const test of spec.tests ?? []) {
          for (const r of test.results ?? []) {
            for (const att of r.attachments ?? []) {
              if (att.name && att.path) {
                attachments.push({ name: att.name, path: att.path, contentType: att.contentType });
                if (att.contentType?.startsWith('image/') || att.name.includes('screenshot')) {
                  screenshots.push(att.path);
                }
              }
            }
          }
        }
        failedSpecs.push({
          title: spec.title ?? '(no title)',
          file: spec.file ?? suite.file,
          ok: false,
          attachments,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };

  for (const suite of parsed.suites ?? []) walk(suite);
  return { totalSpecs, failedSpecs, screenshots };
}

export async function runPlaywright(
  worktreePath: string,
  config?: VerifyConfig,
): Promise<VerifyKindResult & { summary?: PlaywrightSummary; bootstrap?: BootstrapResult }> {
  if (!hasPlaywrightConfig(worktreePath)) {
    return {
      ok: false,
      durationMs: 0,
      output: '[playwright] no playwright.config.{ts,js,mjs} found in worktree',
    };
  }
  const cfg = config ?? loadVerifyConfig(worktreePath);

  const bootstrap = await ensureBrowsersInstalled(worktreePath, {
    timeoutMs: cfg.timeouts.playwrightBootstrap,
  });
  if (!bootstrap.cached && !bootstrap.installed) {
    return {
      ok: false,
      durationMs: bootstrap.durationMs,
      output: `[playwright] browser install failed:\n${bootstrap.output}`,
      bootstrap,
    };
  }

  const reportPath = resolve(worktreePath, '.omc-playwright-report.json');
  const result = await runProcess(
    'npx',
    ['playwright', 'test', '--reporter=json'],
    {
      cwd: worktreePath,
      timeoutMs: cfg.timeouts.playwright,
      // Allowlisted child env + the report-path var only; no secret inherit.
      env: verifyChildEnv(process.env, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath }),
    },
  );

  let reportSource = '';
  try {
    if (existsSync(reportPath)) reportSource = readFileSync(reportPath, 'utf8');
  } catch {
    reportSource = '';
  }
  if (!reportSource) reportSource = result.output;
  const summary = parsePlaywrightReport(reportSource);

  return {
    ok: result.ok && summary.failedSpecs.length === 0,
    durationMs: result.durationMs,
    output: result.output,
    summary,
    bootstrap,
  };
}
