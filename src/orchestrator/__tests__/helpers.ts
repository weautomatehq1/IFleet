import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capabilities } from '../capabilities';
import { PressureTracker } from '../pressure';
import { SprintManager, type TaskBriefLoader } from '../sprint';
import { StateStore } from '../store';
import { WorkerRegistry } from '../workers';
import type {
  OrchestratorEvent,
  SpawnHandle,
  SpawnOpts,
  SpawnResult,
  SprintId,
  TaskId,
  WorkerAdapter,
} from '../types';

export interface TempEnv {
  dir: string;
  dbPath: string;
  workersConfig: string;
  store: StateStore;
  registry: WorkerRegistry;
  cleanup: () => void;
}

export interface MakeTempEnvOptions {
  /**
   * Override the `authProfile` of the default `w1` worker written to
   * `workers.json`. Defaults to `'api'` so the budget guard (which only fires
   * when at least one enabled worker is API-keyed) remains active for the
   * existing budget tests. Pass a non-`'api'` value (e.g. `'default'`) to
   * exercise the Max-plan skip path.
   */
  authProfile?: string;
}

export function makeTempEnv(opts: MakeTempEnvOptions = {}): TempEnv {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-orch-'));
  const dbPath = join(dir, 'state.db');
  const workersConfig = join(dir, 'workers.json');
  writeFileSync(
    workersConfig,
    JSON.stringify({
      workers: [
        {
          id: 'w1',
          provider: 'claude',
          authProfile: opts.authProfile ?? 'api',
          maxConcurrent: 2,
          enabled: true,
        },
      ],
    }),
  );
  const store = new StateStore(dbPath);
  const registry = new WorkerRegistry({ configPath: workersConfig, watchFs: false });
  return {
    dir,
    dbPath,
    workersConfig,
    store,
    registry,
    cleanup: () => {
      registry.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface MockAdapterOptions {
  exitCode?: number;
  pr?: string;
  error?: string;
  delayMs?: number;
  throwOnSpawn?: Error;
  controllable?: boolean;
  totalCostUsd?: number;
}

export class MockAdapter implements WorkerAdapter {
  spawned: Array<{ taskId: TaskId; brief: string }> = [];
  resolvers: Array<(result: SpawnResult) => void> = [];
  cancelled: TaskId[] = [];
  private readonly opts: MockAdapterOptions;

  constructor(opts: MockAdapterOptions = {}) {
    this.opts = opts;
  }

  async spawn(taskId: TaskId, brief: string, _opts: SpawnOpts): Promise<SpawnHandle> {
    void _opts;
    if (this.opts.throwOnSpawn) throw this.opts.throwOnSpawn;
    this.spawned.push({ taskId, brief });
    let resolver: (result: SpawnResult) => void = () => undefined;
    const done = new Promise<SpawnResult>((resolve) => {
      resolver = resolve;
    });
    this.resolvers.push(resolver);
    if (!this.opts.controllable) {
      setTimeout(() => {
        resolver({
          taskId,
          workerId: 'w1',
          exitCode: this.opts.exitCode ?? 0,
          pr: this.opts.pr,
          error: this.opts.error,
          totalCostUsd: this.opts.totalCostUsd,
        });
      }, this.opts.delayMs ?? 0);
    }
    return {
      workerId: 'w1',
      taskId,
      cancel: async () => {
        this.cancelled.push(taskId);
        resolver({ taskId, workerId: 'w1', exitCode: 130, error: 'cancelled' });
      },
      done,
    };
  }

  finishAll(result: Partial<SpawnResult> = {}): void {
    while (this.resolvers.length) {
      const r = this.resolvers.shift();
      if (!r) continue;
      r({
        taskId: this.spawned[0]?.taskId ?? ('' as TaskId),
        workerId: 'w1',
        exitCode: 0,
        ...result,
      });
    }
  }
}

export const noopBriefLoader: TaskBriefLoader = {
  loadBrief: async () => 'noop-brief',
};

export interface ManagerHarness {
  env: TempEnv;
  manager: SprintManager;
  pressure: PressureTracker;
  adapter: MockAdapter;
  events: OrchestratorEvent[];
}

export function makeManager(opts: {
  now?: () => number;
  adapter?: MockAdapter;
  briefLoader?: TaskBriefLoader;
  capabilities?: Capabilities;
  budgetUsd?: number;
  /** Forwarded to {@link makeTempEnv} — controls the lone worker's auth profile. */
  authProfile?: string;
  onBudgetPaused?: (sprintId: SprintId, spentUsd: number, limitUsd: number) => void | Promise<void>;
  onRatePaused?: (sprintId: SprintId, resetAt: number) => void | Promise<void>;
} = {}): ManagerHarness {
  const env = makeTempEnv({ authProfile: opts.authProfile });
  const pressure = new PressureTracker({ now: opts.now });
  const adapter = opts.adapter ?? new MockAdapter();
  const events: OrchestratorEvent[] = [];
  const manager = new SprintManager({
    store: env.store,
    registry: env.registry,
    pressure,
    adapter,
    briefLoader: opts.briefLoader ?? noopBriefLoader,
    emit: (event) => events.push(event),
    capabilities: opts.capabilities,
    now: opts.now,
    budgetUsd: opts.budgetUsd,
    onBudgetPaused: opts.onBudgetPaused,
    onRatePaused: opts.onRatePaused,
  });
  return { env, manager, pressure, adapter, events };
}
