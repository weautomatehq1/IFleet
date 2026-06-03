import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { WorkerConfig, WorkerId } from './types';

export const DEFAULT_WORKERS_CONFIG = join(process.cwd(), 'config', 'workers.json');

/**
 * Sentinel value for {@link WorkerConfig.authProfile} that signals the worker
 * is billed via an Anthropic API key (real per-call USD spend). The budget
 * cap in `SprintManager.checkBudget` only enforces when at least one enabled
 * worker uses this profile — see issue #162. Any other value (e.g.
 * `'default'`, `'claude-max-2'`) is treated as a Max-plan / OAuth profile
 * where the CLI's reported cost does not reflect real billing.
 */
export const API_AUTH_PROFILE = 'api';

interface WorkersFile {
  workers: ReadonlyArray<WorkerConfig>;
}

export interface WorkerRegistryOptions {
  configPath?: string;
  watchFs?: boolean;
  onReload?: (workers: ReadonlyArray<WorkerConfig>) => void;
}

export class WorkerRegistry {
  private readonly configPath: string;
  private workers: ReadonlyArray<WorkerConfig> = [];
  private readonly inFlight = new Map<WorkerId, number>();
  private watcher?: FSWatcher;
  private readonly onReload?: (workers: ReadonlyArray<WorkerConfig>) => void;
  private reloadTimer?: NodeJS.Timeout;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.configPath = opts.configPath ?? DEFAULT_WORKERS_CONFIG;
    this.onReload = opts.onReload;
    this.loadFromDisk();
    if (opts.watchFs !== false) {
      this.attachWatcher();
    }
  }

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as WorkersFile;
      this.workers = (parsed.workers ?? []).filter((w) => w.enabled);
    } catch (err) {
      console.warn(`[WorkerRegistry] failed to load config from ${this.configPath}: ${String(err)} — booting with zero workers`);
      this.workers = [];
    }
  }

  private attachWatcher(): void {
    try {
      this.watcher = watch(this.configPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.loadFromDisk();
          if (this.onReload) this.onReload(this.workers);
        }, 100);
      });
    } catch {
      // file may not exist yet; skip
    }
  }

  stop(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  all(): ReadonlyArray<WorkerConfig> {
    return this.workers;
  }

  byId(id: WorkerId): WorkerConfig | undefined {
    return this.workers.find((w) => w.id === id);
  }

  inFlightFor(id: WorkerId): number {
    return this.inFlight.get(id) ?? 0;
  }

  hasCapacity(id: WorkerId): boolean {
    const cfg = this.byId(id);
    if (!cfg) return false;
    return this.inFlightFor(id) < cfg.maxConcurrent;
  }

  availableWorkers(): WorkerId[] {
    return this.workers
      .filter((w) => this.inFlightFor(w.id) < w.maxConcurrent)
      .map((w) => w.id);
  }

  acquire(id: WorkerId): boolean {
    if (!this.hasCapacity(id)) return false;
    this.inFlight.set(id, this.inFlightFor(id) + 1);
    return true;
  }

  release(id: WorkerId): void {
    const current = this.inFlightFor(id);
    if (current <= 0) return;
    this.inFlight.set(id, current - 1);
  }
}
