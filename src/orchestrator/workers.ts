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

/**
 * Single-seat Max-plan policy enforcement (canonical rule #1 in CLAUDE.md;
 * audit AUDIT-IFleet-a394a4f1).
 *
 * The Claude Max plan is a flat-fee shared quota — running multiple Opus
 * sessions in parallel against the same account burns the nightly quota
 * faster than the operator can react, and the `BUDGET_USD` cap in
 * `SprintManager.checkBudget` intentionally bypasses Max-plan workers (the
 * CLI's per-call USD numbers are not real spend on a Max subscription).
 *
 * Enforcing the cap *in code* — not just in `config/workers.json` — means a
 * future operator who widens the concurrency in config gets a loud boot
 * failure instead of silent quota burn. Tier prefix `max-` matches Anthropic's
 * Max-100 / Max-200 naming (`config/workers.json`).
 */
export function validateMaxPlanConcurrency(
  workers: ReadonlyArray<WorkerConfig>,
): void {
  for (const w of workers) {
    if (typeof w.tier === 'string' && w.tier.startsWith('max-') && w.maxConcurrent > 1) {
      throw new Error(
        `WorkerConfig "${w.id}": tier "${w.tier}" is a Claude Max-plan ` +
          `subscription; maxConcurrent must be 1 to honor the single-seat ` +
          `policy (AUDIT-IFleet-a394a4f1). Got maxConcurrent=${w.maxConcurrent}.`,
      );
    }
  }
}

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
      const enabled = (parsed.workers ?? []).filter((w) => w.enabled);
      // Reject configs that violate the single-seat Max-plan policy. The
      // watcher will re-trigger on the next file change, so an operator who
      // corrects the config is automatically un-stuck.
      validateMaxPlanConcurrency(enabled);
      this.workers = enabled;
    } catch (err) {
      console.error(`[WorkerRegistry] CRITICAL: failed to load config from ${this.configPath}: ${String(err)} — booting with zero workers. No tasks can be dispatched until this is resolved.`);
      this.workers = [];
    }
    if (this.workers.length === 0) {
      console.error('[WorkerRegistry] WARNING: zero enabled workers loaded — no tasks can be dispatched. Check config/workers.json and ensure at least one worker has "enabled": true.');
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
