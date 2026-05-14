import type { WorkerAdapter } from '../../orchestrator/types.ts';

/**
 * Factory that produces a {@link WorkerAdapter}. Factories are stored in the
 * registry by name and invoked on every {@link resolveAdapter} /
 * {@link getActiveAdapter} call, so adapters that depend on per-instance state
 * (cwd, profile, transient HTTP client) can construct fresh instances rather
 * than sharing a singleton across the process.
 */
export type AdapterFactory = () => WorkerAdapter;

/**
 * Name → factory map of every backend implementing
 * {@link import('../../orchestrator/types.ts').WorkerAdapter}. Adapter modules
 * self-register at import time so adding a new backend is a one-file drop-in:
 *
 *   1. Create `src/workers/adapters/<name>.ts`, export a factory, and call
 *      `registerAdapter('<name>', () => createXAdapter())` at module scope.
 *   2. Add the module to `src/workers/adapters/index.ts` so it is imported
 *      (and therefore self-registers) when the registry is touched.
 *
 * No orchestrator change is required. The contract this registry exposes is
 * intentionally narrow: hand back a `WorkerAdapter` and nothing else. That
 * keeps the seam compatible with the following future backends — none of
 * which require schema changes:
 *
 *   - `vllm-local`     — HTTP client posting to `http://localhost:8000/v1/chat/completions`.
 *   - `ollama`         — HTTP client posting to `http://localhost:11434/v1`.
 *   - `mlx`            — HTTP client targeting an Apple Silicon MLX server.
 *   - `anthropic-api`  — `@anthropic-ai/sdk` driven by `ANTHROPIC_API_KEY`.
 *
 * Each of those reduces to "build a `WorkerAdapter` from config" — the same
 * shape `claude-cli` already satisfies.
 */
const REGISTRY = new Map<string, AdapterFactory>();

export const DEFAULT_ADAPTER_NAME = 'claude-cli';
export const ADAPTER_ENV_VAR = 'IFLEET_ADAPTER';

export function registerAdapter(name: string, factory: AdapterFactory): void {
  if (name.trim() === '') throw new Error('adapter name must not be empty');
  REGISTRY.set(name, factory);
}

export function resolveAdapter(name: string): WorkerAdapter {
  const factory = REGISTRY.get(name);
  if (!factory) {
    const known = [...REGISTRY.keys()];
    const list = known.length > 0 ? known.join(', ') : '(none registered)';
    throw new Error(`Unknown WorkerAdapter "${name}". Registered: ${list}`);
  }
  return factory();
}

export function hasAdapter(name: string): boolean {
  return REGISTRY.has(name);
}

export function listAdapters(): readonly string[] {
  return [...REGISTRY.keys()];
}

/**
 * Reads `process.env.IFLEET_ADAPTER` (default `claude-cli`) and returns a
 * fresh adapter instance via its factory.
 */
export function getActiveAdapter(): WorkerAdapter {
  const name = process.env[ADAPTER_ENV_VAR];
  const target = name !== undefined && name !== '' ? name : DEFAULT_ADAPTER_NAME;
  return resolveAdapter(target);
}

/**
 * Test-only: drop every registration. Production code must not call this.
 * Adapter modules re-register on next import via the barrel in
 * {@link ./index.ts}, but tests are responsible for re-importing if needed.
 */
export function __resetAdapterRegistry(): void {
  REGISTRY.clear();
}
