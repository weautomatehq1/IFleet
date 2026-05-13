import { nanoid } from 'nanoid';
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
  briefLoader: TaskBriefLoader;
  emit: (event: OrchestratorEvent) => void;
  now?: () => number;
}

export interface StartSprintOpts {
  mode: SprintMode;
  goal: string;
  taskIds?: ReadonlyArray<TaskId>;
  newTaskBriefs?: ReadonlyArray<string>;
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
  running: new Set(['completed', 'cancelled', 'failed']),
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
  private readonly now: () => number;
  private readonly running = new Map<TaskId, RunningTask>();

  constructor(opts: SprintManagerOptions) {
    this.store = opts.store;
    this.registry = opts.registry;
    this.pressure = opts.pressure;
    this.adapter = opts.adapter;
    this.briefLoader = opts.briefLoader;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
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
      for (const brief of opts.newTaskBriefs) {
        const tid = newTaskId(`tk_${nanoid(10)}`);
        const tRec: TaskRecord = {
          id: tid,
          sprintId: id,
          brief,
          state: { kind: 'pending' },
          attempts: 0,
          createdAt: now,
          updatedAt: now,
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
    this.emit({
      ts: now,
      sprintId: id,
      kind: `sprint.${next.kind}`,
      payload: { from: current.state.kind, to: next.kind },
    });
    return updated;
  }

  async tick(sprintId: SprintId): Promise<void> {
    const sprint = this.store.loadSprint(sprintId);
    if (!sprint) return;
    if (TERMINAL_STATES.has(sprint.state.kind)) return;

    if (sprint.state.kind === 'queued') {
      this.transition(sprintId, { kind: 'running', startedAt: this.now() });
    }

    const tasks = sprint.tasks
      .map((id) => this.store.loadTask(id))
      .filter((t): t is TaskRecord => Boolean(t));

    for (const task of tasks) {
      if (task.state.kind !== 'pending') continue;
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
      brief = await this.briefLoader.loadBrief(task.id);
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

  private async awaitHandle(taskId: TaskId): Promise<void> {
    const entry = this.running.get(taskId);
    if (!entry) return;
    try {
      const result = await entry.handle.done;
      this.registry.release(entry.workerId);
      this.running.delete(taskId);
      const task = this.store.loadTask(taskId);
      if (!task) return;
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
          payload: { pr: result.pr ?? null },
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
          payload: { exitCode: result.exitCode, error: result.error ?? null },
        });
      }
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
