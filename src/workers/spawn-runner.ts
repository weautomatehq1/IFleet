import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerCrashError, type WorkerEvent, type WorkerResult } from './types.ts';

export interface RunnerOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  parseLine: (line: string, emit: (e: WorkerEvent) => void) => void;
  finalize: (state: FinalizeState) => WorkerResult;
  /**
   * Called when the process exits non-zero. Lets the adapter reclassify an
   * expected non-zero exit (e.g. a 429 rate limit, which the CLI reports via
   * the stream and then exits 1) into a real {@link WorkerResult} instead of a
   * {@link WorkerCrashError}. Return `undefined` to treat the exit as a crash
   * (the default). Genuine crashes (segfault, OOM, spawn failure) return
   * `undefined` and still throw.
   */
  classifyExit?: (state: FinalizeState) => WorkerResult | undefined;
  stderrTailLines?: number;
  killGraceMs?: number;
  /** @internal Test-only override for the spawn implementation. Not for production use. */
  spawnImpl?: SpawnLike;
}

export interface SpawnLike {
  (command: string, args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams;
}

export interface FinalizeState {
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  sessionId: string;
}

export interface RunnerHandle {
  pid: number;
  sessionId: Promise<string>;
  events: AsyncIterable<WorkerEvent>;
  result: Promise<WorkerResult>;
  cancel: () => Promise<void>;
}

export function runStreaming(opts: RunnerOptions): RunnerHandle {
  const startedAt = Date.now();
  const spawnFn: SpawnLike = opts.spawnImpl ?? (spawn as unknown as SpawnLike);
  const child = spawnFn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${opts.command}`);
  }

  const eventQueue: WorkerEvent[] = [];
  const waiters: Array<(v: IteratorResult<WorkerEvent>) => void> = [];
  let queueClosed = false;

  const emit = (e: WorkerEvent): void => {
    if (queueClosed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: e, done: false });
    } else {
      eventQueue.push(e);
    }
  };

  const closeQueue = (): void => {
    if (queueClosed) return;
    queueClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: undefined, done: true });
    }
  };

  let sessionId = '';
  const sessionDeferred = createDeferred<string>();
  const resultDeferred = createDeferred<WorkerResult>();
  sessionDeferred.promise.catch(() => {
    // suppress unhandled rejection if caller never awaits sessionId
  });

  const stderrTailLines = opts.stderrTailLines ?? 100;
  const stderrLines: string[] = [];

  const handleLine = (line: string): void => {
    if (line.length === 0) return;
    opts.parseLine(line, (e) => {
      if (e.kind === 'init' && sessionId === '') {
        sessionId = e.sessionId;
        sessionDeferred.resolve(sessionId);
      }
      emit(e);
    });
  };

  attachLineReader(child.stdout, handleLine);
  attachLineReader(child.stderr, (line) => {
    stderrLines.push(line);
    if (stderrLines.length > stderrTailLines) stderrLines.shift();
  });

  let cancelling = false;
  const cancel = async (): Promise<void> => {
    if (cancelling) return;
    cancelling = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const graceMs = opts.killGraceMs ?? 5000;
    await delay(graceMs);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      void cancel();
    } else {
      opts.signal.addEventListener('abort', () => void cancel(), { once: true });
    }
  }

  child.on('error', (err) => {
    if (!sessionDeferred.settled) sessionDeferred.reject(err);
    emit({ kind: 'error', category: 'spawn_error', message: err.message });
    resultDeferred.reject(err);
    closeQueue();
  });

  child.on('close', (code, signal) => {
    const endedAt = Date.now();
    const stderrTail = stderrLines.join('\n');
    if (code === 0) {
      try {
        const result = opts.finalize({
          startedAt,
          endedAt,
          exitCode: code,
          signal,
          stderrTail,
          sessionId,
        });
        if (!sessionDeferred.settled) sessionDeferred.resolve(result.sessionId);
        resultDeferred.resolve(result);
      } catch (err) {
        resultDeferred.reject(err);
        if (!sessionDeferred.settled) sessionDeferred.reject(err);
      }
    } else {
      const state: FinalizeState = { startedAt, endedAt, exitCode: code, signal, stderrTail, sessionId };
      // Give the adapter a chance to reclassify an expected non-zero exit
      // (rate limit) into a result rather than a crash.
      const reclassified = opts.classifyExit?.(state);
      if (reclassified) {
        if (!sessionDeferred.settled) sessionDeferred.resolve(reclassified.sessionId);
        resultDeferred.resolve(reclassified);
      } else {
        const crash = new WorkerCrashError(
          `worker exited with code=${code} signal=${signal}`,
          code,
          signal,
          stderrTail,
        );
        if (!sessionDeferred.settled) sessionDeferred.reject(crash);
        resultDeferred.reject(crash);
      }
    }
    closeQueue();
  });

  const events: AsyncIterable<WorkerEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
      return {
        next(): Promise<IteratorResult<WorkerEvent>> {
          if (eventQueue.length > 0) {
            const value = eventQueue.shift() as WorkerEvent;
            return Promise.resolve({ value, done: false });
          }
          if (queueClosed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<WorkerEvent>> {
          closeQueue();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    pid: child.pid,
    sessionId: sessionDeferred.promise,
    events,
    result: resultDeferred.promise,
    cancel,
  };
}

function attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      onLine(buf.replace(/\r$/, ''));
      buf = '';
    }
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    resolve: (v) => {
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      d.settled = true;
      reject(e);
    },
    settled: false,
  };
  return d;
}
