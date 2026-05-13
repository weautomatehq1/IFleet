import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess } from './spawn-util.js';
import { loadVerifyConfig } from './config-loader.js';
import type { VerifyConfig, VerifyKindResult } from './types.js';

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
): Promise<VerifyKindResult & { summary?: PlaywrightSummary }> {
  if (!hasPlaywrightConfig(worktreePath)) {
    return {
      ok: false,
      durationMs: 0,
      output: '[playwright] no playwright.config.{ts,js,mjs} found in worktree',
    };
  }
  const cfg = config ?? loadVerifyConfig(worktreePath);
  const reportPath = resolve(worktreePath, '.omc-playwright-report.json');
  const result = await runProcess(
    'npx',
    ['playwright', 'test', '--reporter=json'],
    {
      cwd: worktreePath,
      timeoutMs: cfg.timeouts.playwright,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
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
  };
}
