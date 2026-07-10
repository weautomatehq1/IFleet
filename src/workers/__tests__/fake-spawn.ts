import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import type { SpawnLike } from '../spawn-runner.ts';

export interface FakeChildOptions {
  stdoutLines?: string[];
  stderrLines?: string[];
  /**
   * Raw stdout chunks. Written verbatim (no implicit newline) so the test
   * can split a single JSON line across multiple `data` events to verify
   * incremental line reassembly.
   */
  stdoutChunks?: string[];
  exitCode?: number;
  exitSignal?: NodeJS.Signals | null;
  delayBeforeExitMs?: number;
  delayBetweenLinesMs?: number;
  delayBetweenChunksMs?: number;
  hangUntilSignal?: boolean;
  ignoreSigterm?: boolean;
  killDelayMs?: number;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  /** Env passed to the child process. Populated from the SpawnOptions.env field. */
  env?: NodeJS.ProcessEnv;
  /** Content written to stdin (accumulated after spawn, empty string if nothing written). */
  stdin: string;
}

export interface FakeSpawn {
  spawn: SpawnLike;
  calls: SpawnCall[];
}

export function createFakeSpawn(opts: FakeChildOptions): FakeSpawn {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnLike = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const call: SpawnCall = { command, args, env: options?.env as NodeJS.ProcessEnv | undefined, stdin: '' };
    calls.push(call);
    const child = createFakeChild(opts);
    // Accumulate stdin writes so tests can assert on what was piped in.
    child.stdin.on('data', (chunk: Buffer | string) => {
      call.stdin += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    return child as unknown as ReturnType<SpawnLike>;
  }) as SpawnLike;
  return { spawn: spawnFn, calls };
}

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 1_000_000) + 1000;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private killed = false;
  private opts: FakeChildOptions;
  private exitTimer: NodeJS.Timeout | undefined;

  constructor(opts: FakeChildOptions) {
    super();
    this.opts = opts;
    queueMicrotask(() => void this.run());
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const sig = typeof signal === 'string' ? signal : 'SIGTERM';
    if (this.killed && sig !== 'SIGKILL') return false;
    this.killed = true;
    if (sig === 'SIGTERM' && this.opts.ignoreSigterm === true) {
      return true;
    }
    const delay = this.opts.killDelayMs ?? 0;
    setTimeout(() => this.finishWithSignal(sig), delay);
    return true;
  }

  private async run(): Promise<void> {
    const lineDelay = this.opts.delayBetweenLinesMs ?? 0;
    const chunkDelay = this.opts.delayBetweenChunksMs ?? 0;
    for (const line of this.opts.stdoutLines ?? []) {
      if (this.killed) break;
      this.stdout.write(line + '\n');
      if (lineDelay > 0) await sleep(lineDelay);
    }
    for (const chunk of this.opts.stdoutChunks ?? []) {
      if (this.killed) break;
      this.stdout.write(chunk);
      if (chunkDelay > 0) await sleep(chunkDelay);
    }
    for (const line of this.opts.stderrLines ?? []) {
      if (this.killed) break;
      this.stderr.write(line + '\n');
    }
    if (this.opts.hangUntilSignal === true) {
      return;
    }
    const finishDelay = this.opts.delayBeforeExitMs ?? 0;
    this.exitTimer = setTimeout(() => this.finishNormally(), finishDelay);
  }

  private finishNormally(): void {
    this.stdout.end();
    this.stderr.end();
    this.exitCode = this.opts.exitCode ?? 0;
    this.signalCode = this.opts.exitSignal ?? null;
    this.emit('close', this.exitCode, this.signalCode);
  }

  private finishWithSignal(signal: NodeJS.Signals): void {
    if (this.exitTimer) clearTimeout(this.exitTimer);
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.stdout.end();
    this.stderr.end();
    this.exitCode = null;
    this.signalCode = signal;
    this.emit('close', null, signal);
  }
}

function createFakeChild(opts: FakeChildOptions): FakeChild {
  return new FakeChild(opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
