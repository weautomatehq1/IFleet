/**
 * @invariant no-direct-github-import — SprintManager must never import from
 * `src/queue/github.ts` directly. All GitHub calls flow through the queue
 * bridge so SprintManager stays decoupled from GitHub rate-limits and
 * webhook quirks. Documented in CLAUDE.md ("SprintManager emits events. It
 * NEVER calls GitHub directly.").
 *
 * Enforcement: comment-only today. The `@invariant:` JSDoc tag is a
 * machine-readable hook so a future custom-eslint rule or repo-grep CI
 * check can promote this from documentation to enforced policy.
 * AUDIT-IFleet-d55e2033 / 05938a16.
 */
import { nanoid } from 'nanoid';
import type { Capabilities } from './capabilities';
import { isCapabilityAvailable } from './capabilities';
import { PipelineBridge, type PipelineRunnerFactory } from './pipeline-bridge';
import type { PressureTracker } from './pressure';
import type { StateStore } from './store';
import { API_AUTH_PROFILE, type WorkerRegistry } from './workers';
import {
  newSprintId,
  newTaskId,
  type OrchestratorEvent,
  type SprintId,
  type SprintMode,
  type SprintOperatingMode,
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
  /** How the orchestrator operates the sprint (normal vs overnight). */
  mode: SprintOperatingMode;
  /**
   * Optional per-task routing mode passed through to the classifier/pipeline.
   * Most call sites leave this undefined — the classifier infers it from
   * `mode:*` labels or the Haiku auto-router. Set explicitly when an operator
   * pins the mode via Discord slash-command and wants to bypass detection.
   * Stored on each new TaskRecord so the pipeline factory can forward it as a
   * synthetic label into `classifyTask` (see `TaskRecord.mode`).
   */
  taskMode?: SprintMode;
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
  /** Sprints for which `sprint.budget_skipped` has already been emitted.
   *  One-shot per sprint so the event isn't repeated on every task completion
   *  after the cap is first exceeded. Resets implicitly on process restart. */
  private readonly budgetSkipLogged = new Set<SprintId>();
  /**
   * Per-sprint Langfuse parent trace ID. Generated lazily on the first
   * dispatch for a sprint and reused for all subsequent task spawns so
   * every role (architect, editor, verifier, reviewer, doctor) lands under
   * a single sprint-level trace tree. If the orchestrator process already
   * has LANGFUSE_PARENT_TRACE_ID set (manual debugging), claudeChildEnv()
   * will use that value instead — this map just ensures the auto-generated
   * ID is consistent across all tasks in the same sprint.
   */
  private readonly sprintTraceIds = new Map<SprintId, string>();

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
    // Rehydrate per-sprint runtime counters from persistence so a PM2 restart
    // does not reset the BUDGET_USD guard mid-sprint or lose the rate-limit
    // resume timestamp for a paused sprint.
    for (const [sprintId, runtime] of this.store.loadAllSprintRuntime()) {
      if (runtime.spentUsd > 0) this.sprintSpend.set(sprintId, runtime.spentUsd);
      if (runtime.rateResetAt !== null) {
        this.rateLimitResetAt.set(sprintId, runtime.rateResetAt);
      }
    }
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
        // Pin the per-task mode by prepending a `mode: <x>` header to the brief.
        // The classifier reads body headers (see `detectExplicitMode`) so the
        // pipeline picks up the mode without a schema migration on the store.
        const briefWithMode = opts.taskMode
          ? `mode: ${opts.taskMode}\n\n${brief}`
          : brief;
        const tRec: TaskRecord = {
          id: tid,
          sprintId: id,
          brief: briefWithMode,
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
        // Clear the persisted rate-reset so a subsequent restart does not
        // re-pause the sprint on a stale timestamp.
        this.store.saveSprintRateReset(sprintId, null, this.now());
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

    let workerId = this.pickWorker();
    if (workerId) {
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
        await this.dispatch(task, workerId);
        workerId = this.pickWorker();
        if (!workerId) break;
      }
    }

    const freshTasks = sprint.tasks
      .map((id) => this.store.loadTask(id))
      .filter((t): t is TaskRecord => Boolean(t));
    // Guard: if any tasks could not be loaded (corrupt state_json), do not
    // advance the sprint to a terminal state — that would silently discard
    // unprocessed work. store.ts already logs console.error for each corrupt row.
    if (freshTasks.length < sprint.tasks.length) {
      console.error(
        `[sprint] tick: ${sprint.tasks.length - freshTasks.length} task(s) failed to load for sprint ${sprintId} — skipping terminal check`,
      );
      return;
    }
    const allTerminal = freshTasks.every(
      (t) =>
        t.state.kind === 'completed' || t.state.kind === 'failed' || t.state.kind === 'cancelled',
    );
    // Gate completion on THIS sprint's running set, not the global one. With
    // cross-task parallelism (ADR-0001) another sprint may hold a running task
    // in `this.running`; `this.running.size` would then stay non-zero and block
    // this sprint from completing even though all of its own tasks are terminal.
    const sprintRunningCount = Array.from(this.running.values()).filter(
      (r) => r.sprintId === sprintId,
    ).length;
    if (freshTasks.length > 0 && allTerminal && sprintRunningCount === 0) {
      // A worker self-cancel (exit 2) is treated as sprint failure: a sprint where any task did not complete is a failed sprint.
      const anyFailed = freshTasks.some((t) => t.state.kind === 'failed' || t.state.kind === 'cancelled');
      if (anyFailed) {
        this.transition(sprintId, {
          kind: 'failed',
          at: this.now(),
          error: 'one or more tasks failed',
        });
      } else {
        const prs = freshTasks
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
    const newAttempts = task.attempts + 1;
    const nextTaskState: TaskState = {
      kind: 'assigned',
      workerId,
      at: now,
    };
    this.store.saveTask({
      ...task,
      brief,
      state: nextTaskState,
      attempts: newAttempts,
      updatedAt: now,
    });
    this.emit({
      ts: now,
      sprintId: task.sprintId,
      taskId: task.id,
      workerId,
      kind: 'task.assigned',
      payload: { attempt: newAttempts },
    });
    try {
      // Lazy-init per-sprint trace ID: all task spawns in the same sprint share
      // one parent trace so Langfuse groups architect/editor/reviewer under it.
      let parentTraceId = this.sprintTraceIds.get(task.sprintId);
      if (!parentTraceId) {
        parentTraceId = nanoid(21);
        this.sprintTraceIds.set(task.sprintId, parentTraceId);
      }
      const handle = await this.adapter.spawn(task.id, brief, { parentTraceId });
      this.store.saveTask({
        ...task,
        brief,
        state: {
          kind: 'running',
          workerId,
          startedAt: this.now(),
        },
        attempts: newAttempts,
        updatedAt: this.now(),
      });
      this.running.set(task.id, {
        taskId: task.id,
        sprintId: task.sprintId,
        workerId,
        handle,
        startedAt: this.now(),
      });
      void this.awaitHandle(task.id);
    } catch (err) {
      this.registry.release(workerId);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[sprint] dispatch threw for task', task.id, ':', message, err instanceof Error ? err.stack : '');
      this.store.saveTask({
        ...task,
        brief,
        state: { kind: 'failed', at: this.now(), error: message },
        attempts: newAttempts,
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
    // Persist so the running total survives a PM2 restart; the budget guard
    // would otherwise reset to $0 every 5 minutes when the cron bounces the
    // process and re-enters this method against a fresh in-memory Map.
    this.store.saveSprintSpend(sprintId, next, this.now());
    return next;
  }

  private async checkBudget(sprintId: SprintId, spentUsd: number): Promise<boolean> {
    const limit = this.budgetUsd;
    if (limit === undefined || spentUsd < limit) return false;
    // The reported USD comes from the Claude CLI's per-call cost field, which
    // is computed at API list prices regardless of how the request is billed.
    // For a Max-plan OAuth subscription (flat monthly fee) that number is not
    // real spend and the cap fires spuriously after a handful of sprints.
    // Only enforce when at least one enabled worker uses an API auth profile.
    const hasApiWorker = this.registry.all().some((w) => w.authProfile === API_AUTH_PROFILE);
    if (!hasApiWorker) {
      // Emit once per sprint so operators have an observable signal that the
      // cap was silently bypassed — otherwise a future operator who sets
      // BUDGET_USD=5.00 expecting it to fire will get total silence (#162).
      if (!this.budgetSkipLogged.has(sprintId)) {
        this.budgetSkipLogged.add(sprintId);
        this.emit({
          ts: this.now(),
          sprintId,
          kind: 'sprint.budget_skipped',
          payload: {
            spentUsd,
            limitUsd: limit,
            reason: 'no_api_worker',
            workerCount: this.registry.all().length,
          },
        });
      }
      return false;
    }
    const sprint = this.store.loadSprint(sprintId);
    if (!sprint || sprint.state.kind !== 'running') return false;
    this.transition(sprintId, {
      kind: 'paused',
      at: this.now(),
      reason: `budget limit $${limit.toFixed(2)} reached (spent $${spentUsd.toFixed(2)})`,
      startedAt: sprint.state.startedAt,
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
    // Persist so a restart while the sprint is rate-paused does not forget
    // when to auto-resume.
    this.store.saveSprintRateReset(sprintId, resetAt, now);
    this.transition(sprintId, {
      kind: 'paused',
      at: now,
      reason: `rate cap reached, waiting until ${new Date(resetAt).toISOString()}`,
      startedAt: sprint.state.startedAt,
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
      switch (result.exitCode) {
        case 0:
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
            payload: { pr: result.pr ?? null, costUsd: result.totalCostUsd ?? 0, totalTokens: result.totalTokens ?? 0 },
          });
          break;
        case 2:
          this.store.saveTask({
            ...task,
            state: { kind: 'cancelled', at: this.now(), reason: result.error ?? 'cancelled by worker' },
            updatedAt: this.now(),
          });
          this.emit({
            ts: this.now(),
            sprintId: task.sprintId,
            taskId,
            workerId: entry.workerId,
            kind: 'task.cancelled',
            payload: { exitCode: result.exitCode, costUsd: result.totalCostUsd ?? 0 },
          });
          break;
        case 3:
          this.store.saveTask({
            ...task,
            state: { kind: 'failed', at: this.now(), error: result.error ?? 'blocked_by_reviewer' },
            updatedAt: this.now(),
          });
          this.emit({
            ts: this.now(),
            sprintId: task.sprintId,
            taskId,
            workerId: entry.workerId,
            kind: 'task.capability_blocked',
            payload: { exitCode: result.exitCode, error: result.error ?? null, costUsd: result.totalCostUsd ?? 0 },
          });
          break;
        default:
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
          break;
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
    // Auto-loop: re-tick on the next event-loop turn so the next pending task
    // dispatches as soon as a worker frees up, instead of waiting for the
    // PM2 cron tick (~5 min). The internal guards in tick() — terminal /
    // paused state checks, pickWorker availability — keep this from spinning
    // when there is no work to do.
    this.scheduleTick(entry.sprintId);
  }

  /**
   * Schedule a deferred `tick(sprintId)` after the current microtask flushes.
   * Used by `awaitHandle` so task completion immediately drives the next
   * dispatch without waiting for the external cron. Errors are swallowed —
   * the next external tick will retry, and surfacing them here would mask
   * the original task-completion event the caller cares about.
   */
  private scheduleTick(sprintId: SprintId): void {
    setImmediate(() => {
      try {
        const sprint = this.store.loadSprint(sprintId);
        if (!sprint) return;
        if (TERMINAL_STATES.has(sprint.state.kind)) return;
        // A budget pause sets state to `paused`; the cron will still call tick
        // on schedule to check the rate-reset window, so re-driving here would
        // just be noise.
        if (sprint.state.kind === 'paused') return;
        this.tick(sprintId).catch(() => undefined);
      } catch {
        // Store may be closed (e.g. during test teardown) — ignore.
      }
    });
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
    const startedAt = sprint.state.startedAt ?? this.now();
    const updated = this.transition(id, { kind: 'running', startedAt });
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
