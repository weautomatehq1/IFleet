import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { extractAuditFindingId } from '../audit/types.js';
import { DEFAULT_REPO_ID, loadReposConfig, type ReposMap } from '../config/repos';
import type { DiscordOut } from '../contracts/discord-out.js';
import type { QueuedTask } from '../contracts/task.js';
import { DiscordOutbox } from '../observability/discord-outbox.js';
import { setDiscordOutbox } from '../observability/discord-broadcast.js';
import { postTaskDoneNotification } from '../observability/task-done-notify.js';
import type { PipelineRunnerFactory } from './pipeline-bridge';
import { PressureTracker } from './pressure';
import { SprintManager, type StartSprintOpts, type TaskBriefLoader } from './sprint';
import { DEFAULT_DB_PATH, StateStore } from './store';
import { DEFAULT_WORKERS_CONFIG, WorkerRegistry } from './workers';
import type {
  OrchestratorEvent,
  RateLimitHeaders,
  SprintId,
  SprintRecord,
  TaskId,
  WorkerAdapter,
  WorkerConfig,
  WorkerId,
} from './types';

export const DEFAULT_KILL_FLAG_DIR = join(process.cwd(), '.omc', 'sprints');
export const DEFAULT_TICK_MS = 1000;
export const DEFAULT_KILL_POLL_MS = 5000;
export const DISCORD_DRAIN_INTERVAL_MS = 30_000;

export interface OrchestratorOptions {
  store?: StateStore;
  registry?: WorkerRegistry;
  pressure?: PressureTracker;
  adapter: WorkerAdapter;
  /**
   * When provided, wraps the factory in a {@link PipelineBridge} and drives the
   * full Architect → Editor → Reviewer pipeline. The {@link adapter} field
   * remains required for backwards compatibility but is used as a fallback only.
   */
  pipelineFactory?: PipelineRunnerFactory;
  /**
   * Callback called when {@link WorkerRegistry} fires `onReload` so the
   * factory's account pool can be refreshed. Pass the `rebuildPool` function
   * returned by {@link makeProductionFactory} here.
   */
  onWorkersReload?: (workers: ReadonlyArray<WorkerConfig>) => void;
  /** Repo identifier in "owner/name" form used by the production factory. */
  repoId?: string;
  /**
   * Parsed `config/repos.json` content. When provided, the first key is used
   * as the default {@link repoId} unless `repoId` is set explicitly. Tests
   * omit this and continue to rely on the {@link DEFAULT_REPO_ID} fallback.
   */
  reposConfig?: ReposMap;
  briefLoader: TaskBriefLoader;
  dbPath?: string;
  workersConfigPath?: string;
  killFlagDir?: string;
  tickIntervalMs?: number;
  killPollIntervalMs?: number;
  now?: () => number;
  autoResume?: boolean;
  /** USD spend cap per sprint. Defaults to BUDGET_USD env var. Omit to disable. */
  budgetUsd?: number;
  /** Discord webhook URL for budget and rate-cap alerts. Defaults to DISCORD_IFLEET_WEBHOOK env var. */
  discordWebhookUrl?: string;
  /** Durable Discord outbox. When provided, broadcastIFleet is wired to enqueue before sending. */
  discordOutbox?: DiscordOutbox;
  /** Path to the claude CLI for generating task-done summaries. Defaults to CLAUDE_PATH env var or 'claude'. */
  claudePath?: string;
  /**
   * Discord output adapter. When provided, task lifecycle events are routed
   * to per-task Discord threads (see src/observability/discord-output.ts).
   * Requires {@link queuedTaskLoader} to resolve taskId → QueuedTask.
   */
  discordOut?: DiscordOut;
  /**
   * Resolves an orchestrator-side taskId to T2's unified {@link QueuedTask}.
   * Required when {@link discordOut} is set. Returning null is treated as
   * "no Discord routing for this task" and silently dropped.
   */
  queuedTaskLoader?: (taskId: TaskId) => QueuedTask | null;
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
  private readonly repoId: string;
  private readonly discordWebhookUrl: string | undefined;
  private readonly claudePath: string;
  private readonly discordOut: DiscordOut | undefined;
  private readonly queuedTaskLoader: ((taskId: TaskId) => QueuedTask | null) | undefined;
  /** taskId → Discord threadId. Memoized per-process so a single PR thread
   *  collects assigned/progress/completed messages without reopening. */
  private readonly taskThreadIds = new Map<TaskId, string>();
  private readonly outbox: DiscordOutbox | undefined;
  private tickTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private drainTimer?: NodeJS.Timeout;
  private morningDrainTimer?: NodeJS.Timeout;
  private started = false;
  private activeSprintIds = new Set<SprintId>();

  constructor(opts: OrchestratorOptions) {
    this.now = opts.now ?? Date.now;
    this.repoId = resolveRepoId(opts);
    this.store = opts.store ?? new StateStore(opts.dbPath ?? DEFAULT_DB_PATH);
    this.registry =
      opts.registry ??
      new WorkerRegistry({
        configPath: opts.workersConfigPath ?? DEFAULT_WORKERS_CONFIG,
        onReload: opts.onWorkersReload,
      });
    this.pressure = opts.pressure ?? new PressureTracker({ now: this.now });
    this.killFlagDir = opts.killFlagDir ?? DEFAULT_KILL_FLAG_DIR;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.killPollIntervalMs = opts.killPollIntervalMs ?? DEFAULT_KILL_POLL_MS;
    const budgetUsd = opts.budgetUsd ?? parseBudgetEnv();
    const discordWebhookUrl = opts.discordWebhookUrl ?? process.env['DISCORD_IFLEET_WEBHOOK'];
    this.discordWebhookUrl = discordWebhookUrl;
    this.claudePath = opts.claudePath ?? process.env['CLAUDE_PATH'] ?? 'claude';
    this.discordOut = opts.discordOut;
    this.queuedTaskLoader = opts.queuedTaskLoader;
    this.outbox = opts.discordOutbox;
    this.sprints = new SprintManager({
      store: this.store,
      registry: this.registry,
      pressure: this.pressure,
      adapter: opts.adapter,
      pipelineFactory: opts.pipelineFactory,
      briefLoader: opts.briefLoader,
      emit: (event) => this.handleEvent(event),
      now: this.now,
      budgetUsd,
      onBudgetPaused: discordWebhookUrl
        ? (sprintId, spentUsd, limitUsd) =>
            postDiscordAlert(
              discordWebhookUrl,
              `⚠️ Sprint \`${sprintId}\` paused — budget $${limitUsd.toFixed(2)} reached (spent $${spentUsd.toFixed(2)}). Resume when ready.`,
            )
        : undefined,
      onRatePaused: discordWebhookUrl
        ? (sprintId, resetAt) =>
            postDiscordAlert(
              discordWebhookUrl,
              `⏸️ Sprint \`${sprintId}\` paused — rate cap reached, auto-resuming at ${new Date(resetAt).toISOString()}.`,
            )
        : undefined,
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
    if (this.outbox) {
      setDiscordOutbox(this.outbox);
      this.drainTimer = setInterval(() => {
        void this.drainDiscordOutbox();
      }, DISCORD_DRAIN_INTERVAL_MS);
      this.drainTimer.unref();
      this.scheduleMorningDrain();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.killTimer) clearInterval(this.killTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.morningDrainTimer) clearTimeout(this.morningDrainTimer);
    if (this.outbox) setDiscordOutbox(null);
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

  /**
   * Resume a paused sprint (e.g. after a budget pause). Re-adds the sprint to
   * the active set so the tick loop will continue dispatching its tasks.
   */
  resumeSprint(id: SprintId, reason: string = 'operator resume'): SprintRecord {
    const rec = this.sprints.resumeSprint(id, reason);
    this.activeSprintIds.add(id);
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
    // Only run the legacy single-channel webhook notification when no
    // DiscordOut adapter is wired. With DiscordOut active, dispatchToDiscord
    // already posts a per-task thread message — running both would
    // double-post.
    if (!this.discordOut && event.kind === 'task.completed' && event.taskId) {
      const prUrl = event.payload['pr'] as string | undefined;
      const task = this.store.loadTask(event.taskId);
      if (task) {
        void postTaskDoneNotification({
          taskId: event.taskId,
          prUrl,
          brief: task.brief,
          webhookUrl: this.discordWebhookUrl,
          claudePath: this.claudePath,
        });
      }
    }
    if (this.discordOut && this.queuedTaskLoader && event.taskId) {
      void this.dispatchToDiscord(event, event.taskId);
    }
  }

  /**
   * Route a task lifecycle event to its Discord thread. Idempotent per event:
   * opens the thread lazily on first observed event for a task, then reuses
   * the memoized threadId. Errors inside DiscordOut are caught by the adapter;
   * any error that escapes here is logged but never rethrown so the
   * orchestrator's event loop stays alive.
   */
  private async dispatchToDiscord(event: OrchestratorEvent, taskId: TaskId): Promise<void> {
    if (!this.discordOut || !this.queuedTaskLoader) return;
    // Only completion/failure/cancellation are routed through DiscordOut from
    // here. `task.assigned` is owned by daemon.ts:wireSprintCompletion which
    // re-reads the task to pick up a thread created post-ingest — running
    // both paths would double-post the picked-up message and waste a thread
    // creation call when the task already has one. Short-circuit before any
    // thread resolution so unsupported events don't trigger postTaskCreated
    // / bindThreadToTask side-effects. AUDIT-IFleet-b3fdcf22.
    if (
      event.kind !== 'task.completed' &&
      event.kind !== 'task.failed' &&
      event.kind !== 'task.cancelled'
    ) {
      return;
    }
    try {
      const out = this.discordOut;
      const taskLoader = this.queuedTaskLoader;
      let threadId = this.taskThreadIds.get(taskId);
      if (!threadId) {
        const task = taskLoader(taskId);
        if (!task) return;
        const existing =
          task.source.kind === 'discord' ? task.source.threadId : undefined;
        if (existing) {
          threadId = existing;
          // Tell the adapter the threadId belongs to this taskId so
          // postPlanForApproval can emit `<verb>:<taskId>` customIds.
          out.bindThreadToTask?.(existing, task.id);
        } else {
          const result = await out.postTaskCreated(task);
          if (!result.threadId) return;
          threadId = result.threadId;
        }
        this.taskThreadIds.set(taskId, threadId);
      }
      switch (event.kind) {
        case 'task.completed': {
          const pr = event.payload['pr'] as string | undefined;
          const totalTokens = event.payload['totalTokens'] as number | undefined;
          await out.postCompleted(threadId, pr ?? '');
          this.taskThreadIds.delete(taskId);

          // Channel-level ping for discord-source tasks with a PR.
          const completedTask = taskLoader(taskId);
          if (completedTask?.source.kind === 'discord' && pr) {
            const channelId = completedTask.source.channelId;
            const tokenStr = totalTokens ? ` · ${totalTokens.toLocaleString()} tokens` : '';
            const findingId = extractAuditFindingId(completedTask.brief ?? '');
            const findingStr = findingId ? ` \`${findingId}\` fixed →` : '';
            // ✅ prefix matches broadcastIFleet + per-thread postProgress
            // formats elsewhere so monitoring / search filters that key on
            // the checkmark catch this channel-level ping too.
            // AUDIT-IFleet-3d187de7 / 416ebab1 / 2dee4f76.
            await out.postChannelMessage(channelId, `✅${findingStr} ${pr}${tokenStr}`).catch(() => {});
          }
          return;
        }
        case 'task.failed': {
          const reason = event.payload['error'] as string | undefined;
          await out.postFailed(threadId, reason ?? 'unknown failure');
          this.taskThreadIds.delete(taskId);
          return;
        }
        case 'task.cancelled':
          await out.postProgress(threadId, '🛑 cancelled');
          this.taskThreadIds.delete(taskId);
          return;
        // architect.plan_ready is NOT routed here — the pipeline calls
        // discordOutPlanReady directly via the onArchitectPlan callback
        // injected in daemon.ts. Avoids racing the event bus.
        default:
          return;
      }
    } catch (err) {
      console.warn(
        `[orchestrator] dispatchToDiscord failed for task ${taskId} / ${event.kind}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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

  private async drainDiscordOutbox(): Promise<void> {
    if (!this.outbox) return;
    const url = this.discordWebhookUrl ?? process.env['DISCORD_IFLEET_WEBHOOK'];
    if (!url) return;
    try {
      const result = await this.outbox.drainOnce({
        send: async (_channel, payload) => {
          const parsed = JSON.parse(payload) as { content?: string; url?: string };
          const targetUrl = parsed.url ?? url;
          const content = parsed.content ?? payload;
          await postDiscordAlert(targetUrl, content);
        },
      });
      if (result.failed > 0) {
        console.warn(
          `[orchestrator] discord outbox drain: ${result.sent} sent, ${result.retried} retried, ${result.failed} dead-lettered`,
        );
      }
    } catch (err) {
      console.warn(
        `[orchestrator] discord outbox drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleMorningDrain(): void {
    const ms = msUntilHour(7);
    this.morningDrainTimer = setTimeout(() => {
      void this.drainDiscordOutbox();
      this.scheduleMorningDrain();
    }, ms);
    this.morningDrainTimer.unref();
  }

  /** Repo identifier in "owner/name" form derived from reposConfig or repoId. */
  getRepoId(): string {
    return this.repoId;
  }

  // Test/diagnostic helpers
  getSprint(id: SprintId): SprintRecord | undefined {
    return this.store.loadSprint(id);
  }

  activeSprintIdsSnapshot(): ReadonlyArray<SprintId> {
    return Array.from(this.activeSprintIds);
  }
}

function resolveRepoId(opts: OrchestratorOptions): string {
  if (opts.repoId !== undefined && opts.repoId !== '') return opts.repoId;
  if (opts.reposConfig) {
    const firstKey = Object.keys(opts.reposConfig)[0];
    if (firstKey !== undefined && firstKey !== '') return firstKey;
  }
  return DEFAULT_REPO_ID;
}

/**
 * Production startup helper. Loads `config/repos.json` from `repoRoot` and
 * constructs an {@link Orchestrator} wired with the resulting
 * {@link ReposMap}. Use this from any production entry point so the
 * hardcoded `DEFAULT_REPO_ID` fallback is bypassed by real config.
 */
export interface StartOrchestratorOpts extends Omit<OrchestratorOptions, 'reposConfig'> {
  repoRoot: string;
  reposConfigPath?: string;
}

export function startOrchestrator(opts: StartOrchestratorOpts): Orchestrator {
  const configPath = opts.reposConfigPath ?? join(opts.repoRoot, 'config', 'repos.json');
  const reposConfig = loadReposConfig(configPath);
  return new Orchestrator({ ...opts, reposConfig });
}

function parseBudgetEnv(): number | undefined {
  const raw = process.env['BUDGET_USD'];
  if (!raw) {
    // Only warn when an API key is present — that implies metered billing
    // where an unset BUDGET_USD is actually dangerous. On Max-plan / OAuth
    // sessions (the default for the IFleet daemon) this warning fired on
    // every boot, desensitising operators to real alerts.
    // AUDIT-IFleet-44a424a6.
    if (process.env['ANTHROPIC_API_KEY']) {
      console.warn(
        '[orchestrator] BUDGET_USD unset but ANTHROPIC_API_KEY is set — ' +
          'per-sprint budget guard disabled on a metered account. Consider ' +
          'setting BUDGET_USD or unsetting ANTHROPIC_API_KEY for Max-plan runs.',
      );
    }
    return undefined;
  }
  const val = Number(raw);
  return Number.isFinite(val) && val > 0 ? val : undefined;
}

function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function postDiscordAlert(webhookUrl: string, content: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content });
    const url = new URL(webhookUrl);
    const req = request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve()); // never let Discord failures propagate
    req.write(body);
    req.end();
  });
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
export { isCapabilityAvailable } from './capabilities';
export type { Capabilities } from './capabilities';
export * from './types';
