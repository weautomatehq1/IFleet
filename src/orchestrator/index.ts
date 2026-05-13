import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PressureTracker } from './pressure';
import { SprintManager, type StartSprintOpts, type TaskBriefLoader } from './sprint';
import { DEFAULT_DB_PATH, StateStore } from './store';
import { DEFAULT_WORKERS_CONFIG, WorkerRegistry } from './workers';
import type {
  OrchestratorEvent,
  RateLimitHeaders,
  SprintId,
  SprintRecord,
  WorkerAdapter,
  WorkerId,
} from './types';

export const DEFAULT_KILL_FLAG_DIR = join(process.cwd(), '.omc', 'sprints');
export const DEFAULT_TICK_MS = 1000;
export const DEFAULT_KILL_POLL_MS = 5000;

export interface OrchestratorOptions {
  store?: StateStore;
  registry?: WorkerRegistry;
  pressure?: PressureTracker;
  adapter: WorkerAdapter;
  briefLoader: TaskBriefLoader;
  dbPath?: string;
  workersConfigPath?: string;
  killFlagDir?: string;
  tickIntervalMs?: number;
  killPollIntervalMs?: number;
  now?: () => number;
  autoResume?: boolean;
}

export class Orchestrator {
  private readonly store: StateStore;
  private readonly registry: WorkerRegistry;
  private readonly pressure: PressureTracker;
  private readonly sprints: SprintManager;
  private readonly emitter = new EventEmitter();
  private readonly killFlagDir: string;
  private readonly tickIntervalMs: number;
  private readonly killPollIntervalMs: number;
  private readonly now: () => number;
  private tickTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private started = false;
  private activeSprintIds = new Set<SprintId>();

  constructor(opts: OrchestratorOptions) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new StateStore(opts.dbPath ?? DEFAULT_DB_PATH);
    this.registry =
      opts.registry ??
      new WorkerRegistry({
        configPath: opts.workersConfigPath ?? DEFAULT_WORKERS_CONFIG,
      });
    this.pressure = opts.pressure ?? new PressureTracker({ now: this.now });
    this.killFlagDir = opts.killFlagDir ?? DEFAULT_KILL_FLAG_DIR;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.killPollIntervalMs = opts.killPollIntervalMs ?? DEFAULT_KILL_POLL_MS;
    this.sprints = new SprintManager({
      store: this.store,
      registry: this.registry,
      pressure: this.pressure,
      adapter: opts.adapter,
      briefLoader: opts.briefLoader,
      emit: (event) => this.handleEvent(event),
      now: this.now,
    });
    if (opts.autoResume !== false) {
      const resumed = this.sprints.resumeAbandoned();
      for (const id of resumed) this.activeSprintIds.add(id);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.killFlagDir, { recursive: true });
    this.tickTimer = setInterval(() => {
      void this.runTick();
    }, this.tickIntervalMs);
    this.killTimer = setInterval(() => {
      this.pollKillSwitch();
    }, this.killPollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.killTimer) clearInterval(this.killTimer);
    this.registry.stop();
    this.store.close();
  }

  submitSprint(opts: StartSprintOpts): SprintRecord {
    const rec = this.sprints.startSprint(opts);
    this.activeSprintIds.add(rec.id);
    return rec;
  }

  async cancelSprint(id: SprintId, reason: string): Promise<SprintRecord> {
    const rec = await this.sprints.cancelSprint(id, reason);
    this.activeSprintIds.delete(id);
    return rec;
  }

  recordRateLimitHeaders(workerId: WorkerId, headers: RateLimitHeaders): void {
    const snap = this.pressure.recordHeaders(workerId, headers);
    this.store.saveRateLimit({ ...snap, tokensLimit: headers.tokensLimit });
    this.handleEvent({
      ts: this.now(),
      sprintId: '' as SprintId,
      workerId,
      kind: 'ratelimit.observed',
      payload: { pressure: snap.pressure, tokensRemaining: snap.tokensRemaining },
    });
  }

  on(event: string, cb: (event: OrchestratorEvent) => void): this {
    this.emitter.on(event, cb as (...args: unknown[]) => void);
    return this;
  }

  off(event: string, cb: (event: OrchestratorEvent) => void): this {
    this.emitter.off(event, cb as (...args: unknown[]) => void);
    return this;
  }

  private handleEvent(event: OrchestratorEvent): void {
    this.store.appendEvent(event);
    this.emitter.emit('event', event);
    this.emitter.emit(event.kind, event);
    if (
      event.kind === 'sprint.completed' ||
      event.kind === 'sprint.cancelled' ||
      event.kind === 'sprint.failed'
    ) {
      this.activeSprintIds.delete(event.sprintId);
    }
  }

  private async runTick(): Promise<void> {
    const ids = Array.from(this.activeSprintIds);
    for (const id of ids) {
      try {
        await this.sprints.tick(id);
      } catch (err) {
        this.handleEvent({
          ts: this.now(),
          sprintId: id,
          kind: 'tick.error',
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  private pollKillSwitch(): void {
    for (const id of this.activeSprintIds) {
      const flag = join(this.killFlagDir, id, 'cancel.flag');
      if (existsSync(flag)) {
        void this.cancelSprint(id, 'kill flag detected');
      }
    }
  }

  // Test/diagnostic helpers
  getSprint(id: SprintId): SprintRecord | undefined {
    return this.store.loadSprint(id);
  }

  activeSprintIdsSnapshot(): ReadonlyArray<SprintId> {
    return Array.from(this.activeSprintIds);
  }
}

export { PressureTracker, computePressure } from './pressure';
export { StateStore, DEFAULT_DB_PATH } from './store';
export { WorkerRegistry, DEFAULT_WORKERS_CONFIG } from './workers';
export {
  SprintManager,
  canTransitionSprint,
  VALID_SPRINT_TRANSITIONS,
  TERMINAL_STATES,
} from './sprint';
export type { StartSprintOpts, TaskBriefLoader } from './sprint';
export * from './types';
