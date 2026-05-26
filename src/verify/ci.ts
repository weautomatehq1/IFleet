import { runProcess, type SpawnResult } from './spawn-util.js';
import { loadVerifyConfig } from './config-loader.js';
import type { VerifyConfig, VerifyKind, VerifyKindResult } from './types.js';

type CiKind = Extract<VerifyKind, 'typecheck' | 'lint' | 'test'>;

const PNPM_SCRIPT: Record<CiKind, string> = {
  typecheck: 'typecheck',
  lint: 'lint',
  test: 'test',
};

// IFleet is a pnpm workspace; npm reads package-lock.json (we ship
// pnpm-lock.yaml) and would either install the wrong dep tree or fail. Closes
// AUDIT-IFleet-7a4b40d2.
export async function runCiKind(
  worktreePath: string,
  kind: CiKind,
  config?: VerifyConfig,
): Promise<VerifyKindResult> {
  const cfg = config ?? loadVerifyConfig(worktreePath);
  const timeoutMs = cfg.timeouts[kind];
  const script = PNPM_SCRIPT[kind];
  const result: SpawnResult = await runProcess('pnpm', ['run', script, '--silent'], {
    cwd: worktreePath,
    timeoutMs,
  });
  return { ok: result.ok, durationMs: result.durationMs, output: result.output };
}
