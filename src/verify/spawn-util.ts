import { spawn, type SpawnOptions } from 'node:child_process';
import { OUTPUT_BUFFER_CAP_BYTES } from './types.js';

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
    env: opts.env ?? process.env,
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
