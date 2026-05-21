/**
 * Langfuse trace client singleton for IFleet (Phase 1.1 — observability).
 *
 * IFleet runs Claude via the `claude` CLI as a subprocess (`src/workers/`), not
 * via the Anthropic SDK directly. There is no SDK call to wrap, so this module
 * provides a thin trace primitive that the orchestrator-level adapter
 * (`src/workers/adapters/claude-cli.ts`) wraps around every spawn — one trace
 * per Claude subprocess invocation.
 *
 * Disabled (no-op) when env vars are absent so tests and local dev don't crash.
 * Self-hosted Langfuse lives on the VPS at http://127.0.0.1:3010 (P1.1).
 */

import { Langfuse } from 'langfuse';

export interface LangfuseEnv {
  publicKey?: string | undefined;
  secretKey?: string | undefined;
  baseUrl?: string | undefined;
}

export interface TraceInput {
  name: string;
  taskId: string;
  workerId: string;
  model: string;
  brief: string;
  metadata?: Record<string, unknown>;
}

export interface TraceOutput {
  ok: boolean;
  exitCode: number;
  totalCostUsd?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  outputText?: string | undefined;
}

export interface LangfuseTrace {
  end(output: TraceOutput): void;
}

let cached: Langfuse | undefined | null = undefined;

/**
 * Returns the singleton Langfuse client, or `null` when env vars are absent.
 * Exported for testing only — production code should use {@link startTrace}.
 */
export function getLangfuseClient(env: LangfuseEnv = readEnv()): Langfuse | null {
  if (cached !== undefined) return cached;
  if (!env.publicKey || !env.secretKey) {
    cached = null;
    return null;
  }
  cached = new Langfuse({
    publicKey: env.publicKey,
    secretKey: env.secretKey,
    baseUrl: env.baseUrl ?? 'http://127.0.0.1:3010',
    flushAt: 1,
    flushInterval: 1000,
  });
  return cached;
}

/** Reset cached client — test helper only. */
export function resetLangfuseClient(): void {
  cached = undefined;
}

function readEnv(): LangfuseEnv {
  return {
    publicKey: process.env['LANGFUSE_PUBLIC_KEY'],
    secretKey: process.env['LANGFUSE_SECRET_KEY'],
    baseUrl: process.env['LANGFUSE_BASE_URL'],
  };
}

/**
 * Start a trace for one Claude subprocess invocation. Returns a handle whose
 * `end()` finalises the trace with the spawn result. Safe to call when Langfuse
 * is disabled — returns a no-op handle.
 */
export function startTrace(input: TraceInput): LangfuseTrace {
  const client = getLangfuseClient();
  if (client === null) {
    return { end: () => undefined };
  }

  const trace = client.trace({
    name: input.name,
    metadata: {
      taskId: input.taskId,
      workerId: input.workerId,
      model: input.model,
      ...(input.metadata ?? {}),
    },
    input: { brief: input.brief },
    tags: ['ifleet', input.name],
  });

  const generation = trace.generation({
    name: input.name,
    model: input.model,
    input: input.brief,
    startTime: new Date(),
  });

  return {
    end(output: TraceOutput): void {
      try {
        generation.end({
          output: output.outputText ?? '',
          level: output.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: output.error,
          usageDetails: output.totalCostUsd !== undefined
            ? { totalCostUsd: output.totalCostUsd }
            : undefined,
        });
        trace.update({
          output: {
            ok: output.ok,
            exitCode: output.exitCode,
            totalCostUsd: output.totalCostUsd,
            durationMs: output.durationMs,
            error: output.error,
          },
        });
        // flushAt:1 means each event ships immediately, but flush() guarantees
        // the trace is on the wire before the worker process exits.
        void client.flushAsync();
      } catch {
        // observability must never break the worker lifecycle
      }
    },
  };
}
