import { nanoid } from 'nanoid';
import type { Capabilities } from './capabilities';
import { isCapabilityAvailable } from './capabilities';
import { PipelineBridge, type PipelineRunnerFactory } from './pipeline-bridge';
import type { PressureTracker } from './pressure';
import type { StateStore } from './store';
import type { WorkerRegistry } from './workers';
import {
  newSprintId,
  newTaskId,
  type OrchestratorEvent,
  type SprintId,
  type SprintMode,
  type SprintRecord,
  type SprintState,
  type SpawnHandle,
  type TaskId,
  type TaskRecord,
  type TaskState,
  type WorkerAdapter,
  type WorkerId,
} from './types';

export interface TaskBriefLoader {
  loadBrief(taskId: TaskId): Promise<string>;
}

export interface SprintManagerOptions {
  store: StateStore;
  registry: WorkerRegistry;
  pressure: PressureTracker;
  adapter: WorkerAdapter;
  /**
   * When provided, the manager wraps the factory in a {@link PipelineBridge}
   * and drives the full Architect → Editor → Reviewer pipeline instead of
   * calling the raw `adapter`. The `adapter` field is still required as the
   * low-level primitive (it remains the fallback when no factory is supplied).
   */
  pipelineFactory?: PipelineRunnerFactory;
  briefLoader: TaskBriefLoader;
  emit: (event: OrchestratorEvent) => void;
  capabilities?: Capabilities;
  now?: () => number;
  /** USD spend cap per sprint. When exceeded the sprint transitions to `paused`. */
  budgetUsd?: number;
  /** Called when a sprint is paused due to budget exhaustion. */
  onBudgetPaused?: (sprintId: SprintId, spentUsd: number, limitUsd: number) => void | Promise<void>;
  /** Called when a sprint is paused because all workers are rate-cap blocked. */
  onRatePaused?: (sprintId: SprintId, resetAt: number) => void | Promise<void>;
}

export interface StartSprintOpts {
  mode: SprintMode;
  goal: string;
  taskIds?: ReadonlyArray<TaskId>;
  newTaskBriefs?: ReadonlyArray<string>;
  /** Per-task capability requirements, mapped 1:1 to newTaskBriefs by index. */
  newTaskRequirements?: ReadonlyArray<ReadonlyArray<string>>;
}

interface RunningTask {
  taskId: TaskId;
  sprintId: SprintId;
  workerId: WorkerId;
  handle: SpawnHandle;
  startedAt: number;
}

export const TERMINAL_STATES: ReadonlySet<SprintState['kind']> = new Set([
  'cancelled',
  'completed',
  'failed',
]);

export const VALID_SPRINT_TRANSITIONS: Readonly<
  Record<SprintState['kind'], ReadonlySet<SprintState['kind']>>
> = {
  queued: new Set(['planning', 'running', 'cancelled', 'failed']),
  planning: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['completed', 'cancelled', 'failed', 'paused']),
  paused: new Set(['running', 'cancelled', 'failed']),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set(),
};

export function canTransitionSprint(
  from: SprintState['kind'],
  to: SprintState['kind'],
): boolean {
  return VALID_SPRINT_TRANSITIONS[from].has(to);
}

export class SprintManager {
  private readonly store: StateStore;
  private readonly registry: WorkerRegistry;
  private readonly pressure: PressureTracker;
  private readonly adapter: WorkerAdapter;
  private readonly briefLoader: TaskBriefLoader;
  private readonly emit: (event: OrchestratorEvent) => void;
  private readonly capabilities: Capabilities | undefined;
  private readonly now: () => number;
  private readonly running = new Map<TaskId, RunningTask>();
  private readonly budgetUsd: number | undefined;
  private readonly onBudgetPaused: SprintManagerOptions['onBudgetPaused'];
  private readonly onRatePaused: SprintManagerOptions['onRatePaused'];
  private readonly sprintSpend = new Map<SprintId, number>();
  /** resetAt timestamps for sprints paused due to rate-cap. Used for auto-resume. */
  private readonly rateLimitResetAt = new Map<SprintId, number>();

  constructor(opts: SprintManagerOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.pressure = opts.pressure;
    this.adapter = opts.pipelineFactory
      ? new PipelineBridge(opts.pipelineFactory)
      : opts.adapter;
    this.briefLoader = opts.briefLoader;
    this.emit = opts.emit;
    this.capabilities = opts.capabilities;
    this.now = opts.now ?? Date.now;
    this.budgetUsd = opts.budgetUsd;
    this.onBudgetPaused = opts.onBudgetPaused;
    this.onRatePaused = opts.onRatePaused;
  }

  startSprint(opts: StartSprintOpts): SprintRecord {
    const now = this.now();
    const id = newSprintId(`sp_${nanoid(12)}`);
    const taskIds: TaskId[] = [];
    if (opts.taskIds) {
      taskIds.push(...opts.taskIds);
    }
    const record: SprintRecord = {
      id,
      mode: opts.mode,
      goal: opts.goal,
      tasks: taskIds,
      state: { kind: 'queued' },
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveSprint(record);
    if (opts.newTaskBriefs) {
      for (const [i, brief] of opts.newTaskBriefs.entries()) {
        const tid = newTaskId(`tk_${nanoid(10)}`);
        const requirements = opts.newTaskRequirements?.[i];
        const tRec: TaskRecord = {
          id: tid,
          sprintId: id,
          brief,
          state: { kind: 'pending' },
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          ...(requirements && requirements.length > 0 ? { requiredCapabilities: [...requirements] } : {}),
        };
        this.store.saveTask(tRec);
        taskIds.push(tid);
      }
      record.tasks = taskIds;
      this.store.saveSprint(record);
    }
    this.emit({
      ts: now,
      sprintId: id,
      kind: 'sprint.created',
      payload: { mode: opts.mode, goal: opts.goal, taskCount: taskIds.length },
    });
    return record;
  }

  transition(id: SprintId, next: SprintState): SprintRecord {
    const current = this.store.loadSprint(id);
    if (!current) throw new Error(`sprint not found: ${id}`);
    if (!canTransitionSprint(current.state.kind, next.kind)) {
      throw new Error(
        `invalid sprint transition ${current.state.kind} → ${next.kind}`,
      );
    }
    const now = this.now();
    const updated: SprintRecord = { ...current, state: next, updatedAt: now };
    this.store.saveSprint(updated);
    const basePayload = { from: current.state.kind, to: next.kind };
    const payload =
      next.kind === 'completed'
        ? {
            ...basePayload,
            durationMs: current.state.kind === 'running' ? now - current.state.startedAt : 0,
            prs: next.prs,
          }
        : basePayload;
    this.emit({
      ts: now,
      sprintId: id,
      kind: `sprint.${next.kind}`,
      payload,
    });
    return updated;
  }

  async tick(sprintId: SprintId): Promise<void> {
    let sprint = this.store.loadSprint(sprintId);
    if (!sprint) return;
    if (TERMINAL_STATES.has(sprint.state.kind)) return;

    if (sprint.state.kind === 'paused') {
      const resetAt = this.rateLimitResetAt.get(sprintId);
      if (resetAt !== undefined && this.now() >= resetAt) {
        this.rateLimitResetAt.delete(sprintId);
        this.resumeSprint(sprintId, 'rate window opened');
        sprint = this.store.loadSprint(sprintId);
        if (!sprint) return;
      } else {
        return;
      }
    }

    if (sprint.state.kind === 'queued') {
      this.transition(sprintId, { kind: 'running', startedAt: this.now() });
    }

    const tasks = sprint.tasks
      .map((id) => this.store.loadTask(id))
      .filter((t): t is TaskRecord => Boolean(t));

    for (const task of tasks) {
      if (task.state.kind !== 'pending') continue;
      if (this.capabilities) {
        const caps = this.capabilities;
        const missing = (task.requiredCapabilities ?? []).filter(
          (cap) => !isCapabilityAvailable(cap, caps),
        );
        if (missing.length > 0) {
          const ts = this.now();
          this.store.saveTask({
            ...task,
            state: { kind: 'failed', at: ts, error: `missing capabilities: ${missing.join(', ')}` },
            updatedAt: ts,
          });
          this.emit({
            ts,
            sprintId: task.sprintId,
            taskId: task.id,
            kind: 'task.capability_blocked',
            payload: { missing },
          });
          continue;
        }
      }
      const workerId = this.pickWorker();
      if (!workerId) break;
      await this.dispatch(task, workerId);
    }

    const allTerminal = tasks.every(
      (t) =>
        t.state.kind === 'completed' || t.state.kind === 'failed',
    );
    if (tasks.length > 0 && allTerminal && this.running.size === 0) {
      const anyFailed = tasks.some((t) => t.state.kind === 'failed');
      if (anyFailed) {
        this.transition(sprintId, {
          kind: 'failed',
          at: this.now(),
          error: 'one or more tasks failed',
        });
      } else {
        const prs = tasks
          .map((t) => (t.state.kind === 'completed' ? t.state.pr : undefined))
          .filter((p): p is string => Boolean(p));
        this.transition(sprintId, { kind: 'completed', at: this.now(), prs });
      }
      return;
    }

    // Pause if pending tasks exist but all workers are rate-cap blocked.
    const pendingCount = tasks.filter((t) => t.state.kind === 'pending').length;
    const sprintHasRunning = Array.from(this.running.values()).some((r) => r.sprintId === sprintId);
    if (pendingCount > 0 && !sprintHasRunning && !this.pickWorker()) {
      await this.checkRateLimit(sprintId);
    }
  }

  private pickWorker(): WorkerId | undefined {
    const available = this.registry.availableWorkers();
    for (const id of available) {
      if (!this.pressure.shouldDispatch(id)) continue;
      return id;
    }
    return undefined;
  }

  private async dispatch(task: TaskRecord, workerId: WorkerId): Promise<void> {
    if (!this.registry.acquire(workerId)) return;
    const now = this.now();
    let brief = task.brief;
    if (!brief) {
      try {
        brief = await this.briefLoader.loadBrief(task.id);
      } catch (err) {
        this.registry.release(workerId);
        const message = err instanceof Error ? err.message : String(err);
        this.store.saveTask({
          ...task,
          state: { kind: 'failed', at: this.now(), error: message },
          updatedAt: this.now(),
        });
        this.emit({
          ts: this.now(),
          sprintId: task.sprintId,
          taskId: task.id,
          workerId,
          kind: 'task.failed',
          payload: { error: message },
        });
        return;
      }
    }
    const nextTaskState: TaskState = {
      kind: 'assigned',
      workerId,
      at: now,
    };
    this.store.saveTask({
      ...task,
      brief,
      state: nextTaskState,
      attempts: task.attempts + 1,
      updatedAt: now,
    });
    this.emit({
      ts: now,
      sprintId: task.sprintId,
      taskId: task.id,
      workerId,
      kind: 'task.assigned',
      payload: { attempt: task.attempts + 1 },
    });
    try {
      const handle = await this.adapter.spawn(task.id, brief, {});
      this.running.set(task.id, {
        taskId: task.id,
        sprintId: task.sprintId,
        workerId,
        handle,
        startedAt: this.now(),
      });
      this.store.saveTask({
        ...task,
        brief,
        state: {
          kind: 'running',
          workerId,
          startedAt: this.now(),
        },
        attempts: task.attempts + 1,
        updatedAt: this.now(),
      });
      void this.awaitHandle(task.id);
    } catch (err) {
      this.registry.release(workerId);
      const message = err instanceof Error ? err.message : String(err);
      this.store.saveTask({
        ...task,
        brief,
        state: { kind: 'failed', at: this.now(), error: message },
        attempts: task.attempts + 1,
        updatedAt: this.now(),
      });
      this.emit({
        ts: this.now(),
        sprintId: task.sprintId,
        taskId: task.id,
        workerId,
        kind: 'task.failed',
        payload: { error: message },
      });
    }
  }

  private accumulateCost(sprintId: SprintId, costUsd: number | undefined): number {
    if (!costUsd) return this.sprintSpend.get(sprintId) ?? 0;
    const prev = this.sprintSpend.get(sprintId) ?? 0;
    const next = prev + costUsd;
    this.sprintSpend.set(sprintId, next);
    return next;
  }

  private async checkBudget(sprintId: SprintId, spentUsd: number): Promise<boolean> {
    const limit = this.budgetUsd;
    if (limit === undefined || spentUsd < limit) return false;
    const sprint = this.store.loadSprint(sprintId);
    if (!sprint || sprint.state.kind !== 'running') return false;
    this.transition(sprintId, {
      kind: 'paused',
      at: this.now(),
      reason: `budget limit $${limit.toFixed(2)} reached (spent $${spentUsd.toFixed(2)})`,
    });
    this.emit({
      ts: this.now(),
      sprintId,
      kind: 'sprint.budget_paused',
      payload: { spentUsd, limitUsd: limit },
    });
    await this.onBudgetPaused?.(sprintId, spentUsd, limit);
    return true;
  }

  private async checkRateLimit(sprintId: SprintId): Promise<void> {
    const sprint = this.store.loadSprint(sprintId);
    if (!sprint || sprint.state.kind !== 'running') return;

    const workers = this.registry.all();
    if (workers.length === 0) return;

    const allBlocked = workers.every((w) => !this.pressure.shouldDispatch(w.id));
    if (!allBlocked) return;

    const now = this.now();
    const futureSlots = workers
      .map((w) => this.pressure.nextAvailableSlot(w.id))
      .filter((r) => r > now);
    if (futureSlots.length === 0) return;

    const resetAt = Math.min(...futureSlots);
    this.rateLimitResetAt.set(sprintId, resetAt);
    this.transition(sprintId, {
      kind: 'paused',
      at: now,
      reason: `rate cap reached, waiting until ${new Date(resetAt).toISOString()}`,
    });
    this.emit({
      ts: now,
      sprintId,
      kind: 'sprint.rate_paused',
      payload: { resetAt },
    });
    await this.onRatePaused?.(sprintId, resetAt);
  }

  private async awaitHandle(taskId: TaskId): Promise<void> {
    const entry = this.running.get(taskId);
    if (!entry) return;
    try {
      const result = await entry.handle.done;
      this.registry.release(entry.workerId);
      this.running.delete(taskId);
      const task = this.store.loadTask(taskId);
      if (!task) return;
      const spentUsd = this.accumulateCost(task.sprintId, result.totalCostUsd);
      if (result.exitCode === 0) {
        this.store.saveTask({
          ...task,
          state: { kind: 'completed', at: this.now(), pr: result.pr },
          updatedAt: this.now(),
        });
        this.emit({
          ts: this.now(),
          sprintId: task.sprintId,
          taskId,
          workerId: entry.workerId,
          kind: 'task.completed',
          payload: { pr: result.pr ?? null, costUsd: result.totalCostUsd ?? 0 },
        });
      } else {
        this.store.saveTask({
          ...task,
          state: {
            kind: 'failed',
            at: this.now(),
            error: result.error ?? `exit ${result.exitCode}`,
          },
          updatedAt: this.now(),
        });
        this.emit({
          ts: this.now(),
          sprintId: task.sprintId,
          taskId,
          workerId: entry.workerId,
          kind: 'task.failed',
          payload: { exitCode: result.exitCode, error: result.error ?? null, costUsd: result.totalCostUsd ?? 0 },
        });
      }
      await this.checkBudget(task.sprintId, spentUsd);
    } catch (err) {
      this.registry.release(entry.workerId);
      this.running.delete(taskId);
      const task = this.store.loadTask(taskId);
      const message = err instanceof Error ? err.message : String(err);
      if (task) {
        this.store.saveTask({
          ...task,
          state: { kind: 'failed', at: this.now(), error: message },
          updatedAt: this.now(),
        });
      }
      this.emit({
        ts: this.now(),
        sprintId: entry.sprintId,
        taskId,
        workerId: entry.workerId,
        kind: 'task.failed',
        payload: { error: message },
      });
    }
  }

  /**
   * Resume a paused sprint. Idempotent on `running`; throws on terminal states
   * or any other non-paused kind. Emits `sprint.resumed` with the supplied
   * reason so observability can render an operator action.
   */
  resumeSprint(id: SprintId, reason: string = 'operator resume'): SprintRecord {
    const sprint = this.store.loadSprint(id);
    if (!sprint) throw new Error(`sprint not found: ${id}`);
    if (sprint.state.kind === 'running') return sprint;
    if (sprint.state.kind !== 'paused') {
      throw new Error(`cannot resume sprint in state ${sprint.state.kind}`);
    }
    const updated = this.transition(id, { kind: 'running', startedAt: this.now() });
    this.emit({
      ts: this.now(),
      sprintId: id,
      kind: 'sprint.resumed',
      payload: { reason },
    });
    return updated;
  }

  async cancelSprint(id: SprintId, reason: string): Promise<SprintRecord> {
    const sprint = this.store.loadSprint(id);
    if (!sprint) throw new Error(`sprint not found: ${id}`);
    if (TERMINAL_STATES.has(sprint.state.kind)) return sprint;

    const cancels: Promise<void>[] = [];
    for (const [, entry] of this.running) {
      if (entry.sprintId !== id) continue;
      cancels.push(entry.handle.cancel().catch(() => undefined));
    }
    await Promise.allSettled(cancels);

    return this.transition(id, {
      kind: 'cancelled',
      reason,
      at: this.now(),
    });
  }

  resumeAbandoned(): ReadonlyArray<SprintId> {
    const candidates = this.store.listSprintsByStateKind('running');
    const resumed: SprintId[] = [];
    for (const sprint of candidates) {
      const hasLive = Array.from(this.running.values()).some(
        (r) => r.sprintId === sprint.id,
      );
      if (hasLive) continue;
      // Reset any tasks marked running/assigned back to pending so tick() can retry.
      for (const tid of sprint.tasks) {
        const t = this.store.loadTask(tid);
        if (!t) continue;
        if (t.state.kind === 'running' || t.state.kind === 'assigned') {
          this.store.saveTask({
            ...t,
            state: { kind: 'pending' },
            updatedAt: this.now(),
          });
        }
      }
      this.emit({
        ts: this.now(),
        sprintId: sprint.id,
        kind: 'sprint.resumed',
        payload: { reason: 'no live workers detected on boot' },
      });
      resumed.push(sprint.id);
    }
    return resumed;
  }

  runningTaskIds(): ReadonlyArray<TaskId> {
    return Array.from(this.running.keys());
  }
}
