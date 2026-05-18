import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAdapter, type ClaudeAdapterOptions } from '../claude.ts';
import type { SpawnOpts as WorkerSpawnOpts, WorkerEvent } from '../types.ts';
import type {
  SpawnHandle,
  SpawnOpts,
  SpawnResult,
  TaskId,
  WorkerAdapter,
  WorkerConfig,
} from '../../orchestrator/types.ts';
import { registerAdapter } from './registry.ts';

/**
 * The `claude-cli` backend wraps the existing Claude Code CLI spawn primitive
 * (`createClaudeAdapter` from `../claude.ts`) into the orchestrator-level
 * {@link WorkerAdapter} contract defined in `src/orchestrator/types.ts`.
 *
 * IFleet currently runs on ONE Max plan via the CLI; no rotation, no API.
 * This adapter therefore pins to the single `claude-max-1` seat from
 * `config/workers.json` unless overridden.
 */

export const CLAUDE_CLI_ADAPTER_NAME = 'claude-cli';
const DEFAULT_WORKER_ID = 'claude-max-1';
const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_WORKERS_CONFIG = join(process.cwd(), 'config', 'workers.json');

export interface ClaudeCliAdapterOptions {
  /** Worker config id to read from `config/workers.json`. Default `claude-max-1`. */
  workerId?: string;
  /** Working directory passed to the CLI. Defaults to `process.cwd()`. */
  workingDir?: string;
  /** Absolute path to the workers config JSON. Defaults to `<cwd>/config/workers.json`. */
  configPath?: string;
  /** Override the inner Claude adapter (binary + spawnImpl). Primarily for tests. */
  inner?: ClaudeAdapterOptions;
  /** Fallback model when neither the spawn opts nor the worker config provide one. */
  defaultModel?: string;
}

export function createClaudeCliAdapter(opts: ClaudeCliAdapterOptions = {}): WorkerAdapter {
  const workerId = opts.workerId ?? DEFAULT_WORKER_ID;
  const workingDir = opts.workingDir ?? process.cwd();
  const configPath = opts.configPath ?? DEFAULT_WORKERS_CONFIG;
  const fallbackModel = opts.defaultModel ?? DEFAULT_MODEL;
  const workerCfg = loadWorkerConfig(configPath, workerId);
  const inner = createClaudeAdapter(opts.inner ?? {});

  return {
    async spawn(taskId: TaskId, brief: string, spawnOpts: SpawnOpts): Promise<SpawnHandle> {
      const model = pickModel(spawnOpts.model, workerCfg, fallbackModel);
      const workerOpts: WorkerSpawnOpts = {
        taskId,
        brief,
        model,
        workingDir,
      };
      const profile = workerCfg?.authProfile;
      if (profile !== undefined && profile !== '' && profile !== 'default') {
        workerOpts.authProfile = profile;
      }

      const handle = inner.spawn(workerOpts);

      // Drain events so the in-memory queue does not grow unbounded for long
      // runs. Orchestrator-level callers consume `done`, not the raw stream.
      void drain(handle.events);

      const done: Promise<SpawnResult> = handle.result.then(
        (result): SpawnResult => {
          const spawnResult: SpawnResult = {
            taskId,
            workerId,
            exitCode: result.ok ? 0 : 1,
          };
          if (typeof result.totalCostUsd === 'number') {
            spawnResult.totalCostUsd = result.totalCostUsd;
          }
          return spawnResult;
        },
        (err: unknown): SpawnResult => ({
          taskId,
          workerId,
          exitCode: 1,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

      // The pid is exposed synchronously by the inner spawn; never await
      // sessionId here (it would block until the CLI emits `init`).
      return {
        workerId,
        taskId,
        pid: handle.pid,
        cancel: handle.cancel,
        done,
      };
    },
  };
}

function pickModel(
  requested: string | undefined,
  cfg: WorkerConfig | undefined,
  fallback: string,
): string {
  if (requested !== undefined && requested !== '') return requested;
  const first = cfg?.models?.[0];
  if (typeof first === 'string' && first !== '') return first;
  return fallback;
}

function loadWorkerConfig(configPath: string, workerId: string): WorkerConfig | undefined {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { workers?: ReadonlyArray<WorkerConfig> };
    return parsed.workers?.find((w) => w.id === workerId);
  } catch {
    return undefined;
  }
}

async function drain(events: AsyncIterable<WorkerEvent>): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _evt of events) {
      // intentionally empty — drain only.
    }
  } catch {
    // swallow: drain failures must not affect the SpawnResult lifecycle.
  }
}

// Self-register on import. Importing `./index.ts` (the barrel) is enough to
// make `claude-cli` resolvable; downstream code never imports this file.
registerAdapter(CLAUDE_CLI_ADAPTER_NAME, () => createClaudeCliAdapter());
