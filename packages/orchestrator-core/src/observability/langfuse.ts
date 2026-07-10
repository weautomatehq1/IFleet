/**
 * Langfuse trace client singleton for IFleet (Phase 1.1 — observability).
 *
 * IFleet runs Claude via the `claude` CLI as a subprocess (`src/workers/`), not
 * via the Anthropic SDK directly. There is no SDK call to wrap, so this module
 * provides a thin trace primitive that the orchestrator-level adapter
 * (`src/workers/adapters/claude-cli.ts`) wraps around every spawn.
 *
 * Per ADR-0001:36-42 the invariant is ONE shared trace per sprint, with each
 * Claude subprocess (architect, editor, reviewer, …) as a generation/span under
 * it. Pass LANGFUSE_PARENT_TRACE_ID to attach a subprocess to an existing sprint
 * trace. When the env var is absent the first call creates the sprint-level trace
 * and exposes its ID via LangfuseTrace.traceId for propagation to siblings.
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
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  outputText?: string | undefined;
}

export interface LangfuseTrace {
  end(output: TraceOutput): void;
  /**
   * ID of the sprint-level trace created by this call.
   * Defined only when LANGFUSE_PARENT_TRACE_ID was not set (i.e. this call
   * created the parent trace). Pass it to sibling subprocess spawns as
   * LANGFUSE_PARENT_TRACE_ID so all roles land under one sprint trace.
   *
   * TODO(AUDIT-IFleet-32646d9e): wire full propagation through SprintManager
   * so every spawn automatically receives the parent trace ID without manual
   * env-var threading.
   */
  traceId?: string;
}

// Cached per process lifetime — intentional, env vars don't change at runtime
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
 * Start a trace (or attach to an existing sprint trace) for one Claude
 * subprocess invocation. Per ADR-0001:36-42, the correct shape is one
 * Langfuse trace per sprint with each subprocess as a generation under it.
 *
 * When LANGFUSE_PARENT_TRACE_ID is set the generation is created under the
 * existing trace. When it is absent a new sprint-level trace is created and
 * its ID is returned on the handle as `traceId` for propagation to siblings.
 *
 * Returns a no-op handle when Langfuse is disabled.
 */
export function startTrace(input: TraceInput): LangfuseTrace {
  const client = getLangfuseClient();
  if (client === null) {
    return { end: () => undefined };
  }

  const parentTraceId = process.env['LANGFUSE_PARENT_TRACE_ID'];
  const isChildSpan = typeof parentTraceId === 'string' && parentTraceId !== '';

  const trace = isChildSpan
    ? client.trace({ id: parentTraceId })
    : client.trace({
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
    traceId: isChildSpan ? undefined : trace.traceId,
    end(output: TraceOutput): void {
      try {
        const hasTokens =
          output.inputTokens !== undefined || output.outputTokens !== undefined;
        const inputT = output.inputTokens ?? 0;
        const outputT = output.outputTokens ?? 0;
        generation.end({
          output: output.outputText ?? '',
          level: output.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: output.error,
          usageDetails: hasTokens
            ? {
                input_tokens: inputT,
                output_tokens: outputT,
                total_tokens: inputT + outputT,
              }
            : undefined,
          costDetails: output.totalCostUsd !== undefined
            ? { total: output.totalCostUsd }
            : undefined,
        });
        // Only update sprint-level metadata when we own the trace (no parent).
        if (!isChildSpan) {
          trace.update({
            output: {
              ok: output.ok,
              exitCode: output.exitCode,
              totalCostUsd: output.totalCostUsd,
              durationMs: output.durationMs,
              error: output.error,
            },
          });
        }
        // flushAt:1 means each event ships immediately, but flush() guarantees
        // the trace is on the wire before the worker process exits.
        void client.flushAsync();
      } catch {
        // observability must never break the worker lifecycle
      }
    },
  };
}
