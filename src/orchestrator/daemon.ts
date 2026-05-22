// IFleet daemon entry point — PM2 app `ifleet`.
//
// Responsibilities (single process):
//   - Open the unified TaskStore.
//   - Load config/channels.json (FileChannelRouter).
//   - Boot the discord.js Client (input handlers: slash commands, buttons,
//     reactions). One WS connection lives here.
//   - Boot the DiscordOutAdapter (per-task thread posts).
//   - Boot a local ControlPlane HTTP server (separate port from the public
//     control-plane app) so the Discord client's HMAC POSTs land back inside
//     this process — that gives the ApprovalGate same-process resolution
//     for HITL button verdicts.
//   - Drain pending tasks from the unified store via UnifiedQueueAdapter
//     and submit them as sprints to the Orchestrator.
//   - Graceful SIGTERM: stop orchestrator → drain approval gate → destroy
//     discord client → close control plane → close store.
//
// Required env:
//   IFLEET_HMAC_SECRET    — shared with the Discord bot
//   IFLEET_STATE_DIR      — defaults to ./state
//   IFLEET_REPOS_DIR      — canonical clones live here
//   IFLEET_CHANNELS_PATH  — config/channels.json (default)
//   CONTROL_PLANE_PORT    — daemon-local listener (default 3002)
//   DISCORD_BOT_TOKEN     — bot token
//   GITHUB_TOKEN          — for GitHubIssuesSource + RepoManager
//   BUDGET_USD            — optional per-sprint spend cap
//
// Run: `pnpm start:daemon` or via PM2.

import { execFile } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from 'discord.js';
import { Octokit } from '@octokit/rest';
import { VerifierController, type TaskRunContext } from '../agents/verifier/controller.js';
import {
  handleAuditAutopilot,
  handleAuditFix,
  handleAuditScan,
  handleAuditStatus,
} from '../audit/audit-handler.js';
import { loadReposConfig } from '../config/repos.js';
import { createDiscordClient } from '../discord/client.js';
import { HmacControlPlaneClient } from '../discord/hmac-client.js';
import { DiscordOutAdapter } from '../observability/discord-output.js';
import { makeProductionFactory } from '../pipeline/factory.js';
import { createControlPlane } from '../queue/control-plane.js';
import { GitHubQueue } from '../queue/github.js';
import { GitHubIssuesSource } from '../queue/sources/github.js';
import { DiscordSource } from '../queue/sources/discord.js';
import { TaskStore, defaultTasksDbPath } from '../queue/store.js';
import { UnifiedQueueAdapter } from '../queue/unified-adapter.js';
import { FileChannelRouter } from '../repos/router.js';
import { titleToBranchName } from '../utils/branch-name.js';
import { newTaskId, type OrchestratorEvent, type SprintId, type TaskId, type WorkerConfig } from './types.js';
import { Orchestrator } from './index.js';
import { ControlPlaneApprovalGate } from './approval-gate.js';
import { decodeBridgeBrief, encodeBridgeBrief } from './pipeline-bridge.js';
import type { PipelineRunBootstrap, PipelineRunnerFactory } from './pipeline-bridge.js';
import type { PipelineEvent } from '../pipeline/types.js';
import { StateStore } from './store.js';
import type { QueuedTask } from '../contracts/task.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_DAEMON_PORT = 3002;
const REPO_ROOT_ENV = 'IFLEET_REPO_ROOT';

async function main(): Promise<void> {
  const repoRoot = process.env[REPO_ROOT_ENV] ?? process.cwd();
  const channelsPath = process.env['IFLEET_CHANNELS_PATH']
    ?? resolvePath(repoRoot, 'config', 'channels.json');
  const hmacSecret = requireEnv('IFLEET_HMAC_SECRET');
  const discordToken = requireEnv('DISCORD_BOT_TOKEN');
  const githubToken = requireEnv('GITHUB_TOKEN');
  const port = Number(process.env['CONTROL_PLANE_PORT'] ?? DEFAULT_DAEMON_PORT);

  console.warn('[daemon] booting IFleet daemon');

  // -------- Persistent state --------
  const store = new TaskStore(process.env['IFLEET_STATE_DIR'] ? undefined : defaultTasksDbPath());
  const staleCount = store.recoverStale();
  if (staleCount > 0) console.warn(`[daemon] recovered ${staleCount} stale in_flight task(s) → pending`);

  // -------- Routing / repos --------
  const router = FileChannelRouter.fromFile(channelsPath);
  console.warn(`[daemon] loaded ${router.list().length} channel route(s)`);
  const reposMap = loadReposConfig(resolvePath(repoRoot, 'config', 'repos.json'));

  // -------- Discord client (input) --------
  const approvalGate = new ControlPlaneApprovalGate();

  // The Discord bot in this process POSTs HMAC commands to its own
  // in-process ControlPlane. That keeps the wire-format identical between
  // the public control-plane (port 3001) and the daemon's local one (port
  // 3002), and lets the architect's ApprovalGate observe approve/reject
  // verbs without polling.
  const controlPlaneUrl = `http://127.0.0.1:${port}/control`;
  const controlPlaneClient = new HmacControlPlaneClient({
    url: controlPlaneUrl,
    secret: hmacSecret,
  });

  const client: Client = createDiscordClient({
    router,
    controlPlane: controlPlaneClient,
    resolveTaskIdFromMessage: async () => null,
  });

  // -------- DiscordOut adapter (output) --------
  const discordOut = new DiscordOutAdapter({
    client,
    router,
    fallbackChannelId: process.env['DISCORD_FALLBACK_CHANNEL_ID'] ?? undefined,
  });

  // Open the orchestrator's StateStore early so we can wire the
  // discord.post_failed observability callback into DiscordSource below
  // (the callback lands events in the orchestrator's events table).
  const orchestratorStore = new StateStore();

  // -------- Sources + unified adapter --------
  const githubQueue = new GitHubQueue(new Octokit({ auth: githubToken }), {
    repos: Object.values(reposMap),
  });
  const githubSource = new GitHubIssuesSource(githubQueue);
  const discordSource = new DiscordSource({
    router,
    out: discordOut,
    store,
    onPostFailed: (taskId, method, reason) => {
      // Persist as a structured event so operators can query why a Discord
      // thread suddenly stopped updating (resolves the silent-no-op gap
      // flagged in the #165 audit). Tolerant — best effort.
      try {
        const task = store.getById(taskId);
        const sprintId = (task as { sprintId?: string } | null)?.sprintId
          ?? ('' as SprintId);
        orchestratorStore.appendEvent({
          ts: Date.now(),
          sprintId: sprintId as SprintId,
          taskId: taskId as TaskId,
          kind: 'discord.post_failed',
          payload: { method, reason },
        });
      } catch (err) {
        console.warn('[daemon] discord.post_failed event append threw:', err);
      }
    },
  });
  const unified = new UnifiedQueueAdapter(store, {
    github: githubSource,
    discord: discordSource,
  }, discordOut);

  // -------- Production pipeline factory + emit wiring --------
  const initialWorkers = loadInitialWorkers();
  const octokit = new Octokit({ auth: githubToken });
  const productionFactory = makeProductionFactory({
    repoRoot,
    octokit,
    initialWorkers,
  });

  // Verifier needs taskId → {repoUrl, branch, sha, worktreePath}. The pipeline
  // factory knows three of those at bootstrap and the SHA in teardown — capture
  // both before the worktree is torn down (which happens before task.completed).
  const verifierCtx = new TaskContextRegistry();

  // Cancel any sprints still marked 'running' from a previous crash so
  // resumeAbandoned() has nothing to recover — preventing double-dispatch when
  // recoverStale() just reset their tasks back to pending.
  const staleSprintNow = Date.now();
  for (const sprint of orchestratorStore.listSprintsByStateKind('running')) {
    orchestratorStore.saveSprint({
      ...sprint,
      state: { kind: 'failed', at: staleSprintNow, error: 'cancelled: stale on daemon boot' },
      updatedAt: staleSprintNow,
    });
  }

  const orchestrator = new Orchestrator({
    store: orchestratorStore,
    adapter: { spawn: () => Promise.reject(new Error('raw spawn disabled — use pipelineFactory')) },
    pipelineFactory: wrapFactoryWithVerifierContext(
      wrapFactoryWithApprovalAndEmit(
        productionFactory.factory,
        approvalGate,
        (taskId, plan) => discordOutPlanReady(taskId, plan, store, discordOut),
        (taskId, event) => persistPipelineEvent(orchestratorStore, taskId, event),
      ),
      verifierCtx,
    ),
    onWorkersReload: productionFactory.rebuildPool,
    reposConfig: reposMap,
    briefLoader: { loadBrief: async () => '' },
    discordOut,
    queuedTaskLoader: (taskId) => store.getById(taskId),
  });

  const verifierController = new VerifierController({
    store: orchestratorStore,
    emit: (event) => orchestratorStore.appendEvent(event),
    resolveTaskContext: (taskId) =>
      resolveVerifierContext(taskId, verifierCtx, orchestratorStore),
    repoSlug: 'IFleet',
    invariantsRoot: repoRoot,
  });
  orchestrator.on('event', verifierController.onEvent);

  // -------- ControlPlane HTTP listener (daemon-local) --------
  const cp = createControlPlane({
    queue: legacyQueueShim(githubQueue),
    hmacSecret,
    port,
    onSprintGoal: async (cmd) => {
      if (!cmd.channelId || !cmd.userId || !cmd.userLabel) {
        throw new Error('sprint_goal requires Discord-source fields (channelId, userId, userLabel)');
      }
      // Slash commands carry only an interaction.id, not a messageId — T1
      // sends idempotencyKey instead. Require at least one of the two so
      // dedup is always anchored to a stable client-side identifier.
      if (!cmd.messageId && !cmd.idempotencyKey) {
        throw new Error('sprint_goal requires messageId or idempotencyKey for dedup');
      }
      const task = await discordSource.ingest(
        {
          goal: cmd.goal,
          channelId: cmd.channelId,
          ...(cmd.messageId ? { messageId: cmd.messageId } : {}),
          userId: cmd.userId,
          userLabel: cmd.userLabel,
          ...(cmd.idempotencyKey ? { idempotencyKey: cmd.idempotencyKey } : {}),
          ...(cmd.planOnly ? { planOnly: cmd.planOnly } : {}),
          ...(cmd.repo ? { repo: cmd.repo } : {}),
        },
        store,
      );
      return {
        taskId: task.id,
        ...(task.source.kind === 'discord' && task.source.threadId
          ? { threadId: task.source.threadId }
          : {}),
      };
    },
    onApprove: async (taskId) => {
      approvalGate.resolve(taskId, 'approve');
    },
    onAuditScan: async (cmd) => {
      void handleAuditScan(cmd.channelId, { router, client }).catch((err) =>
        console.warn('[daemon] handleAuditScan failed:', err),
      );
    },
    onAuditFix: async (cmd) => {
      void handleAuditFix(cmd.channelId, { router, client }).catch((err) =>
        console.warn('[daemon] handleAuditFix failed:', err),
      );
    },
    onAuditAutopilot: async (cmd) => {
      void handleAuditAutopilot(cmd.channelId, { router, client }).catch((err) =>
        console.warn('[daemon] handleAuditAutopilot failed:', err),
      );
    },
    onAuditStatus: async (cmd) => {
      void handleAuditStatus(cmd.channelId, { router, client }).catch((err) =>
        console.warn('[daemon] handleAuditStatus failed:', err),
      );
    },
    onCancel: async (taskId, reason) => {
      // Mark as failed first so the picked-up state flips back before the
      // architect resolves cancel — keeps the store consistent if the
      // architect is still mid-spawn.
      try {
        store.updateState(taskId, 'failed', { reason: reason ?? 'cancelled via control plane' });
      } catch {
        /* row may not exist yet */
      }
      approvalGate.resolve(taskId, 'cancel');
    },
    resolveTask: () => null,
  });

  await cp.start();
  console.warn(`[daemon] control plane listening on ${controlPlaneUrl}`);

  // -------- Boot Discord client --------
  await client.login(discordToken);
  console.warn('[daemon] discord client logged in');

  // -------- Tick loop: drain pending → submitSprint --------
  let running = true;
  const tickIntervalMs = Number(process.env['IFLEET_DAEMON_TICK_MS'] ?? DEFAULT_TICK_MS);
  void runTickLoop(unified, orchestrator, () => running, tickIntervalMs, store);

  orchestrator.start();
  console.warn(`[daemon] orchestrator started — polling every ${tickIntervalMs}ms`);

  // -------- Graceful shutdown --------
  const shutdown = async (sig: string): Promise<void> => {
    if (!running) return;
    running = false;
    console.warn(`[daemon] ${sig} — shutting down`);
    try {
      approvalGate.drain();
    } catch (err) {
      console.warn('[daemon] approval drain failed:', err);
    }
    try {
      await orchestrator.stop();
    } catch (err) {
      console.warn('[daemon] orchestrator.stop failed:', err);
    }
    try {
      await client.destroy();
    } catch (err) {
      console.warn('[daemon] client.destroy failed:', err);
    }
    try {
      await cp.stop();
    } catch (err) {
      console.warn('[daemon] cp.stop failed:', err);
    }
    try {
      store.close();
    } catch (err) {
      console.warn('[daemon] store.close failed:', err);
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Periodically drain pending tasks from the unified store and submit each as
 * a single-task sprint to the Orchestrator. The orchestrator's pipeline
 * factory does the actual work; this loop only owns the seam between
 * "queued task" and "running sprint".
 */
async function runTickLoop(
  adapter: UnifiedQueueAdapter,
  orchestrator: Orchestrator,
  isRunning: () => boolean,
  tickMs: number,
  store: TaskStore,
): Promise<void> {
  while (isRunning()) {
    try {
      const task = await adapter.pickNext();
      if (task) {
        const brief = encodeBridgeBrief(task);
        const sprintRec = orchestrator.submitSprint({
          mode: 'normal',
          goal: task.title,
          newTaskBriefs: [brief],
        });
        // adapter already flipped the row to in_flight inside pickNext().
        // Wire the sprint's terminal event back to the unified queue so the
        // task row transitions out of in_flight (done / failed).
        wireSprintCompletion(sprintRec.id, task, adapter, orchestrator, store);
      }
    } catch (err) {
      console.warn('[daemon] tick failed:', err);
    }
    await sleep(tickMs);
  }
}

/**
 * Registers a one-shot listener on the orchestrator event bus. When the
 * sprint with {@link sprintId} reaches a terminal state (completed/failed/
 * cancelled), the corresponding unified-queue lifecycle method is called so
 * the queue task transitions out of `in_flight`. When a PR URL was captured
 * during the sprint, a {@link PrDecision} row is written to the task store:
 * verdict `'merged'` on success, `'abandoned'` on failure/cancel.
 */
function wireSprintCompletion(
  sprintId: string,
  task: import('../contracts/task.js').QueuedTask,
  adapter: UnifiedQueueAdapter,
  orchestrator: Orchestrator,
  store: TaskStore,
): void {
  let lastPrUrl: string | undefined;
  let lastTotalTokens: number | undefined;

  const handler = (event: OrchestratorEvent): void => {
    if (event.sprintId !== sprintId) return;

    if (event.kind === 'task.completed') {
      lastPrUrl = event.payload['pr'] as string | undefined;
      lastTotalTokens = event.payload['totalTokens'] as number | undefined;
      return;
    }

    if (event.kind === 'sprint.completed') {
      orchestrator.off('event', handler);

      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          try {
            store.recordPrDecision({
              taskId: task.id,
              repo: task.repo,
              prNumber,
              verdict: 'merged',
              reviewerLogin: null,
            });
          } catch (err) {
            console.warn('[daemon] recordPrDecision(merged) failed:', err);
          }
        }
      }

      void adapter.markCompleted(task, lastPrUrl ?? '', lastTotalTokens).catch((err) =>
        console.warn('[daemon] markCompleted failed:', err),
      );
      return;
    }

    if (event.kind === 'sprint.failed' || event.kind === 'sprint.cancelled') {
      orchestrator.off('event', handler);
      // sprint.failed / sprint.cancelled events carry only { from, to } in
      // payload — the actual error/reason lives on SprintState. Read it from
      // the store via the orchestrator instead of trusting the payload.
      const sprint = orchestrator.getSprint(sprintId as SprintId);
      const reason =
        sprint?.state.kind === 'failed'
          ? sprint.state.error
          : sprint?.state.kind === 'cancelled'
            ? sprint.state.reason
            : event.kind === 'sprint.failed'
              ? 'pipeline failed'
              : 'cancelled';

      // Only record a decision when a PR was opened before the failure/cancel.
      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          try {
            store.recordPrDecision({
              taskId: task.id,
              repo: task.repo,
              prNumber,
              verdict: 'abandoned',
              reviewerLogin: null,
            });
          } catch (err) {
            console.warn('[daemon] recordPrDecision(abandoned) failed:', err);
          }
        }
      }

      void adapter.markFailed(task, reason).catch((err) =>
        console.warn('[daemon] markFailed failed:', err),
      );
    }
  };

  orchestrator.on('event', handler);
}

interface TaskContextRecord {
  repoUrl: string;
  branch: string;
  worktreePath: string;
  sha?: string;
}

export class TaskContextRegistry {
  private readonly map = new Map<string, TaskContextRecord>();
  record(taskId: string, rec: TaskContextRecord): void { this.map.set(taskId, rec); }
  setSha(taskId: string, sha: string): void {
    const r = this.map.get(taskId);
    if (r) r.sha = sha;
  }
  get(taskId: string): TaskContextRecord | undefined { return this.map.get(taskId); }
}

export function wrapFactoryWithVerifierContext(
  inner: PipelineRunnerFactory,
  registry: TaskContextRegistry,
): PipelineRunnerFactory {
  return async (taskId, brief, opts): Promise<PipelineRunBootstrap> => {
    const bootstrap = await inner(taskId, brief, opts);
    const task = decodeBridgeBrief(brief);
    if (task) {
      registry.record(taskId, {
        repoUrl: `https://github.com/${task.repo}`,
        branch: titleToBranchName(task.issueNumber, task.title),
        worktreePath: bootstrap.input.worktreePath,
      });
    }
    const origTeardown = bootstrap.teardown;
    // Capture HEAD SHA before original teardown removes the worktree.
    bootstrap.teardown = async (result) => {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: bootstrap.input.worktreePath,
        });
        registry.setSha(taskId, stdout.trim());
      } catch { /* missing worktree → resolver returns null, verifier skips */ }
      if (origTeardown) await origTeardown(result);
    };
    return bootstrap;
  };
}

async function resolveVerifierContext(
  taskId: TaskId,
  registry: TaskContextRegistry,
  store: StateStore,
): Promise<TaskRunContext | null> {
  const rec = registry.get(taskId);
  const task = store.loadTask(taskId);
  if (!rec || !task || !rec.sha) return null;
  return {
    taskId,
    sprintId: task.sprintId,
    repoUrl: rec.repoUrl,
    branch: rec.branch,
    sha: rec.sha,
    worktreePath: rec.worktreePath,
    attempt: 1,
  };
}

/**
 * Wrap a production PipelineRunnerFactory so the architect can route plan +
 * approval through Discord. Mutates `bootstrap.input` to inject the
 * ApprovalGate and the onArchitectPlan callback before returning.
 */
function wrapFactoryWithApprovalAndEmit(
  inner: PipelineRunnerFactory,
  approvalGate: ControlPlaneApprovalGate,
  onPlan: (taskId: string, plan: string) => Promise<void>,
  emitPipelineEvent?: (taskId: string, event: PipelineEvent) => void,
): PipelineRunnerFactory {
  return async (taskId, brief, opts): Promise<PipelineRunBootstrap> => {
    const bootstrap = await inner(taskId, brief, opts);
    bootstrap.input.approvalGate = approvalGate;
    bootstrap.input.onArchitectPlan = async (plan) => {
      await onPlan(taskId, plan);
    };
    // Wire the pipeline's structured event stream into the orchestrator's
    // event log. Without this, reviewer.rejected (issue #163),
    // plan_reviewer.vetoed/escalated/skipped, and reviewer.haiku_gate_passed
    // are emitted into `undefined?.()` and silently dropped. The translation
    // to OrchestratorEvent happens in main() where the StateStore lives.
    if (emitPipelineEvent) {
      bootstrap.input.eventSink = (event) => {
        try {
          emitPipelineEvent(taskId, event);
        } catch (err) {
          // Per PipelineInput contract: failures inside the sink must not
          // affect the pipeline result. Log and continue.
          console.warn('[daemon] pipeline event sink threw:', err);
        }
      };
    }
    return bootstrap;
  };
}

/**
 * Translate a {@link PipelineEvent} into the orchestrator's {@link OrchestratorEvent}
 * envelope and append to the events table. The sprintId is resolved from the
 * orchestrator store via `loadTask(taskId).sprintId`; if the task lookup fails
 * (race during teardown, store closed), the event is dropped with a warn —
 * the pipeline result is unaffected.
 *
 * This is the missing half of issue #163: PR #166 added the `reviewer.rejected`
 * event but the runner emits it into `input.eventSink?.()` which was `undefined`
 * in production. This persists it (and three sibling events that were also
 * being dropped: `plan_reviewer.vetoed/escalated/skipped`, `reviewer.haiku_gate_passed`).
 */
export function persistPipelineEvent(
  store: StateStore,
  taskId: string,
  event: PipelineEvent,
): void {
  const task = store.loadTask(taskId as TaskId);
  if (!task) {
    console.warn(
      `[daemon] persistPipelineEvent: task ${taskId} not found in state store; dropping event ${event.kind}`,
    );
    return;
  }
  // Strip kind+taskId from the payload — they live on the envelope. Cast via
  // `unknown` because the discriminated-union payload shape varies per kind.
  const { kind: _kind, taskId: _taskId, ...payload } = event as unknown as Record<string, unknown> & {
    kind: string;
    taskId: string;
  };
  store.appendEvent({
    ts: Date.now(),
    sprintId: task.sprintId,
    taskId: task.id,
    kind: event.kind,
    payload,
  });
}

/**
 * Bridge from the architect's plan-ready hook to the per-task Discord
 * thread. Looks up the unified task to find the threadId (Discord-source)
 * or skip silently (GitHub-source — handled via issue commenter).
 */
async function discordOutPlanReady(
  taskId: string,
  plan: string,
  store: TaskStore,
  out: DiscordOutAdapter,
): Promise<void> {
  const task: QueuedTask | null = store.getById(taskId);
  if (!task) return;
  if (task.source.kind !== 'discord') return;
  const threadId = task.source.threadId;
  if (!threadId) return;
  await out.postPlanForApproval(threadId, plan);
}

/**
 * Legacy QueueAdapter shim — ControlPlaneOptions still requires one for the
 * `cancel`/`status` paths. The daemon's onCancel callback handles state
 * transitions via the unified store, so the legacy methods only need to
 * exist; their bodies are intentionally no-ops here.
 */
function legacyQueueShim(_legacy: GitHubQueue): import('../queue/types.js').QueueAdapter {
  return {
    pickNext: async () => null,
    markPicked: async () => undefined,
    markCompleted: async () => undefined,
    markFailed: async () => undefined,
    markCapabilityBlocked: async () => undefined,
    postStatus: async () => undefined,
    watchForNew: () => ({ stop: () => undefined }),
  };
}

function loadInitialWorkers(): ReadonlyArray<WorkerConfig> {
  // The pipeline factory needs at least one worker config to construct an
  // AccountPool. Real configs live in config/workers.json — the orchestrator
  // already reloads from there on SIGHUP, so a minimal bootstrap value is
  // enough to start.
  const cfg: WorkerConfig = {
    id: 'claude-max-1',
    provider: 'claude',
    authProfile: process.env['CLAUDE_AUTH_PROFILE'] ?? 'default',
    models: ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'],
    maxConcurrent: 1,
    enabled: true,
  };
  return [cfg];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[daemon] missing env var: ${name}`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractPrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)(?:\/|$)/.exec(prUrl);
  return m ? parseInt(m[1]!, 10) : null;
}

// CLI entry: invoked when this module is the node entrypoint.
const isEntry =
  typeof process.argv[1] === 'string' && /daemon\.(ts|js|mjs)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error('[daemon] fatal:', err);
    process.exit(1);
  });
}

export {
  main as runDaemon,
  runTickLoop,
  wireSprintCompletion,
  wrapFactoryWithApprovalAndEmit,
  resolveVerifierContext,
};
// Suppress an "unused export" eslint warning for newTaskId — kept exported
// because the daemon's tick loop hands typed TaskIds to submitSprint in
// future iterations.
void newTaskId;
