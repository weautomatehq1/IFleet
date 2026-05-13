import { runProcess, type SpawnResult } from './spawn-util.js';
import { loadVerifyConfig } from './config-loader.js';
import type { VerifyConfig, VerifyKind, VerifyKindResult } from './types.js';

type CiKind = Extract<VerifyKind, 'typecheck' | 'lint' | 'test'>;

const NPM_SCRIPT: Record<CiKind, string> = {
  typecheck: 'typecheck',
  lint: 'lint',
  test: 'test',
};

export async function runCiKind(
  worktreePath: string,
  kind: CiKind,
  config?: VerifyConfig,
): Promise<VerifyKindResult> {
  const cfg = config ?? loadVerifyConfig(worktreePath);
  const timeoutMs = cfg.timeouts[kind];
  const script = NPM_SCRIPT[kind];
  const result: SpawnResult = await runProcess('npm', ['run', script, '--silent'], {
    cwd: worktreePath,
    timeoutMs,
  });
  return { ok: result.ok, durationMs: result.durationMs, output: result.output };
}
