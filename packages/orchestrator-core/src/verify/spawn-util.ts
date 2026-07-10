import { spawn, type SpawnOptions } from 'node:child_process';
import { OUTPUT_BUFFER_CAP_BYTES } from './types.js';

// Process-env *allowlist* for verify subprocesses (`pnpm run …`, `npx
// playwright …`). These run worktree-local `package.json` scripts authored by
// the worker under review, so the child MUST NOT inherit the full parent
// `process.env` — GITHUB_TOKEN, IFLEET_HMAC_SECRET, ANTHROPIC_API_KEY,
// DISCORD_BOT_TOKEN, … would otherwise be one `echo $GITHUB_TOKEN` away from
// exfiltration. Only the keys a Node/pnpm toolchain legitimately needs are
// forwarded; callers add task-specific vars (e.g. PLAYWRIGHT_JSON_OUTPUT_NAME)
// via the `extra` arg, never by spreading `process.env`. Mirrors
// `codexChildEnv()` in `src/workers/codex.ts`. (AUDIT-IFleet-193fb84e)
const VERIFY_ENV_ALLOWLIST = [
  'PATH', // resolve pnpm / npx / node binaries
  'HOME', // npm/pnpm cache + store, ~/.config
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR', // node + tooling scratch dir
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NODE_ENV',
] as const;

/**
 * Build the scoped child env for a verify subprocess. Only allowlisted keys
 * from `source` are forwarded; every secret outside the allowlist is dropped.
 * `extra` keys (task-specific, non-secret env such as
 * `PLAYWRIGHT_JSON_OUTPUT_NAME`) are layered on top and win on collision.
 */
export function verifyChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of VERIFY_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string') out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SpawnRunOptions {
  cwd: string;
  timeoutMs: number;
  capBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runProcess(
  command: string,
  args: string[],
  opts: SpawnRunOptions,
): Promise<SpawnResult> {
  const cap = opts.capBytes ?? OUTPUT_BUFFER_CAP_BYTES;
  const started = Date.now();

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    // Default to the allowlisted child env, never the unfiltered parent env:
    // an absent `env` must not silently leak secrets into worker-authored
    // scripts. Callers needing extra non-secret vars build them via
    // `verifyChildEnv(process.env, { … })`. (AUDIT-IFleet-193fb84e)
    env: opts.env ?? verifyChildEnv(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  const child = spawn(command, args, spawnOpts);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;

  const captureChunk = (data: Buffer): void => {
    if (truncated) return;
    if (totalBytes + data.length > cap) {
      const remaining = cap - totalBytes;
      if (remaining > 0) {
        chunks.push(data.subarray(0, remaining));
        totalBytes += remaining;
      }
      truncated = true;
      return;
    }
    chunks.push(data);
    totalBytes += data.length;
  };

  child.stdout?.on('data', captureChunk);
  child.stderr?.on('data', captureChunk);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, opts.timeoutMs);

  return await new Promise<SpawnResult>((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        output: Buffer.concat(chunks).toString('utf8') + `\n[spawn error] ${message}`,
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString('utf8');
      if (truncated) output += `\n[output truncated at ${cap} bytes]`;
      if (timedOut) output += `\n[killed after ${opts.timeoutMs}ms timeout]`;
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        signal,
        output,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
