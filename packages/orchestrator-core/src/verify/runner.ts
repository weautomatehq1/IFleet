import { runCiKind } from './ci.js';
import { runPlaywright } from './playwright.js';
import { runScreenshotDiff } from './screenshot.js';
import { loadVerifyConfig } from './config-loader.js';
import type {
  VerifyKind,
  VerifyKindResult,
  VerifyResult,
  VerifyRunner,
} from './types.js';

const ALL_KINDS: VerifyKind[] = ['typecheck', 'lint', 'test', 'playwright', 'screenshot'];

function emptyPerKind(): Record<VerifyKind, VerifyKindResult> {
  const skipped: VerifyKindResult = { ok: true, durationMs: 0, output: '[skipped]' };
  return {
    typecheck: skipped,
    lint: skipped,
    test: skipped,
    playwright: skipped,
    screenshot: skipped,
  };
}

export function createVerifyRunner(): VerifyRunner {
  return {
    async run(worktreePath: string, kinds: VerifyKind[]): Promise<VerifyResult> {
      const cfg = loadVerifyConfig(worktreePath);
      const perKind = emptyPerKind();
      const started = Date.now();
      let ok = true;

      const requested = new Set<VerifyKind>(kinds);
      for (const kind of ALL_KINDS) {
        if (!requested.has(kind)) continue;
        let result: VerifyKindResult;
        switch (kind) {
          case 'typecheck':
          case 'lint':
          case 'test':
            result = await runCiKind(worktreePath, kind, cfg);
            break;
          case 'playwright':
            result = await runPlaywright(worktreePath, cfg);
            break;
          case 'screenshot':
            result = await runScreenshotDiff(worktreePath, cfg);
            break;
        }
        perKind[kind] = result;
        if (!result.ok) ok = false;
      }

      return { ok, perKind, totalDurationMs: Date.now() - started };
    },
  };
}
