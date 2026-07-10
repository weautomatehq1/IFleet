import { createClaudeAdapter, type ClaudeAdapterOptions } from '../claude.ts';
import type { WorkerAdapter as PipelineWorkerAdapter } from '../types.ts';
import { ADAPTER_ENV_VAR, DEFAULT_ADAPTER_NAME } from './registry.ts';

/**
 * Pipeline-level (low-level) adapter registry.
 *
 * The sibling {@link ./registry.ts} indexes orchestrator-level
 * {@link import('../../orchestrator/types.ts').WorkerAdapter} factories — a
 * narrow surface that returns a `Promise<SpawnHandle>` with a single `done`
 * promise. The Architect → Editor → Reviewer pipeline (`src/pipeline`) needs
 * the richer worker contract from `src/workers/types.ts` so it can stream
 * events (rate-limit detection), capture the worker's text output, propagate
 * AbortSignal cancellation into the worktree, and forward role-specific
 * system prompts.
 *
 * This registry exposes that lower-level seam. Both registries are selected
 * via the same {@link ADAPTER_ENV_VAR} (`IFLEET_ADAPTER`) so flipping the env
 * var switches both paths consistently.
 */
export type PipelineAdapterFactory = () => PipelineWorkerAdapter;

const REGISTRY = new Map<string, PipelineAdapterFactory>();

export function registerPipelineAdapter(
  name: string,
  factory: PipelineAdapterFactory,
): void {
  if (name.trim() === '') throw new Error('adapter name must not be empty');
  REGISTRY.set(name, factory);
}

export function resolvePipelineAdapter(name: string): PipelineWorkerAdapter {
  const factory = REGISTRY.get(name);
  if (!factory) {
    const known = [...REGISTRY.keys()];
    const list = known.length > 0 ? known.join(', ') : '(none registered)';
    throw new Error(`Unknown pipeline WorkerAdapter "${name}". Registered: ${list}`);
  }
  return factory();
}

export function hasPipelineAdapter(name: string): boolean {
  return REGISTRY.has(name);
}

export function listPipelineAdapters(): readonly string[] {
  return [...REGISTRY.keys()];
}

/**
 * Reads `process.env.IFLEET_ADAPTER` (default `claude-cli`) and returns a
 * fresh pipeline-level adapter via its factory. This is the function
 * `src/pipeline/factory.ts::buildWorkerPool` consumes — flipping
 * `IFLEET_ADAPTER` swaps the underlying backend with no factory.ts edits.
 */
export function getActivePipelineAdapter(): PipelineWorkerAdapter {
  const name = process.env[ADAPTER_ENV_VAR];
  const target = name !== undefined && name !== '' ? name : DEFAULT_ADAPTER_NAME;
  return resolvePipelineAdapter(target);
}

/** Test-only: drop every registration. */
export function __resetPipelineAdapterRegistry(): void {
  REGISTRY.clear();
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------

/**
 * Build-time-overridable options for the default `claude-cli` factory. Tests
 * register their own backends via {@link registerPipelineAdapter} after
 * calling {@link __resetPipelineAdapterRegistry}.
 */
export interface ClaudeCliPipelineOptions {
  inner?: ClaudeAdapterOptions;
}

export function createClaudeCliPipelineAdapter(
  opts: ClaudeCliPipelineOptions = {},
): PipelineWorkerAdapter {
  return createClaudeAdapter(opts.inner ?? {});
}

registerPipelineAdapter(DEFAULT_ADAPTER_NAME, () => createClaudeCliPipelineAdapter());
