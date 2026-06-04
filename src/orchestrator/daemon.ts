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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from 'discord.js';
import { Octokit } from '@octokit/rest';
import { VerifierController, type TaskRunContext } from '../agents/verifier/controller.js';
import { computeStructuralFingerprint } from '../agents/verifier/fingerprint.js';
import { loadReposConfig } from '../config/repos.js';
import { createDiscordClient } from '../discord/client.js';
import { HmacControlPlaneClient } from '../discord/hmac-client.js';
import { broadcastIFleet } from '../observability/discord-broadcast.js';
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
import { requireEnv } from '../utils/env.js';
import type { OrchestratorEvent, SprintId, TaskId, WorkerConfig } from './types.js';
import { Orchestrator } from './index.js';
import { ControlPlaneApprovalGate } from './approval-gate.js';
import {
  clearFleetPause,
  isFleetPaused,
  readPauseInfo,
  setFleetPaused,
} from './fleet-control.js';
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
  const initialWorkers = loadInitialWorkers(resolvePath(repoRoot, 'config', 'workers.json'));
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

  // Unified-store taskId → orchestrator SprintId. /cancel and /stop arrive
  // with the unified ID (Discord ULID / GitHub node_id) and need to reach
  // SprintManager.cancelSprint which is keyed by SprintId. Populated from
  // wireSprintCompletion (which owns both) and pruned in the same handler
  // on terminal sprint events. AUDIT-IFleet-15443528 / ea8d8b2f / 67942487.
  const unifiedToSprintId = new Map<string, SprintId>();

  // Boot recovery ordering (matters — DO NOT REORDER):
  //   1. store.recoverStale() above flips any `in_flight` unified rows back
  //      to `pending` so the tick loop can re-pick them after a crash.
  //   2. The loop below marks any orchestrator sprints still `running` from
  //      that same crash as `failed` so Orchestrator.resumeAbandoned() in
  //      .start() returns empty and does not double-dispatch.
  // Swapping these would let recoverStale revive a task whose sprint is
  // still "running" in the StateStore, and resumeAbandoned would race the
  // tick loop. Documented per AUDIT-IFleet-3b6e4b48.
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
  // Persistent nonce ledger — shares the TaskStore DB so replay protection
  // survives PM2 restart (AUDIT-IFleet-e664f9f3).
  const CP_MAX_SKEW_SEC = 5 * 60;
  const CP_NONCE_TTL_PADDING_SEC = 60;
  const nonceLedger = store.createNonceLedger(
    (CP_MAX_SKEW_SEC + CP_NONCE_TTL_PADDING_SEC) * 1000,
  );
  const cp = createControlPlane({
    queue: legacyQueueShim(githubQueue),
    hmacSecret,
    port,
    nonceLedger,
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
    onVerify: async (taskId) => {
      void verifierController.verifyManual(taskId as TaskId).catch((err) =>
        console.warn('[daemon] verifyManual failed:', err),
      );
    },
    onForcePr: async (taskId, reason) => {
      await handleForcePr(taskId, reason, {
        store,
        orchestratorStore,
        unifiedToSprintId,
        verifierCtx,
        octokit,
      });
    },
    onCancel: async (taskId, reason) => {
      // Resolve `__channel_current__:<channelId>` sentinel emitted by
      // /cancel-with-no-arg. Picks the most recently-created in-flight task
      // in that channel (mirrors how /status defaults to the same channel).
      let resolvedId = taskId;
      if (taskId.startsWith('__channel_current__:')) {
        const channelId = taskId.slice('__channel_current__:'.length);
        if (!/^\d{5,32}$/.test(channelId)) {
          console.warn('[daemon] onCancel: invalid channelId in sentinel:', channelId);
          return;
        }
        const candidates = store.list({ channelId, state: 'in_flight' }, 1);
        if (candidates.length === 0) {
          broadcastIFleet(`⚠ /cancel — no in-flight task in <#${channelId}> to cancel.`);
          return;
        }
        resolvedId = candidates[0]!.id;
      }
      // TOCTOU guard (AUDIT-IFleet-42408e04): re-read the task right before
      // mutating it. If it already completed or failed between sentinel
      // resolution and now, do nothing — overwriting `completed` → `failed`
      // would diverge queue state from reality (the PR is already open).
      const current = store.getById(resolvedId);
      if (current && current.state !== 'in_flight' && current.state !== 'pending') {
        broadcastIFleet(
          `⚠ /cancel — task \`${resolvedId}\` already \`${current.state}\`; nothing to do.`,
        );
        return;
      }
      // Mark as failed first so the picked-up state flips back before the
      // architect resolves cancel — keeps the store consistent if the
      // architect is still mid-spawn.
      try {
        store.updateState(resolvedId, 'failed', { reason: reason ?? 'cancelled via control plane' });
      } catch {
        /* row may not exist yet */
      }
      approvalGate.resolve(resolvedId, 'cancel');
      // Actually abort the running pipeline worker (AUDIT-IFleet-7dd1062f).
      // approvalGate.resolve only unblocks a pipeline waiting at HITL; the
      // SprintManager's cancelSprint walks `running` and calls handle.cancel()
      // which in turn calls abortController.abort() — that's what kills the
      // editor/verifier/reviewer mid-spawn.
      //
      // PR #211 looked up `orchestratorStore.loadTask(resolvedId)` here, but
      // the orchestrator store is keyed by `tk_<nanoid>` IDs (sprint.ts:170)
      // while resolvedId is the unified store's ULID/node_id — the lookup
      // always returned undefined and cancelSprint was never called. The
      // unifiedToSprintId map is populated from wireSprintCompletion (which
      // owns both IDs) so this lookup hits in O(1). AUDIT-IFleet-15443528,
      // ea8d8b2f, 67942487, 11a51d4c.
      try {
        const sprintId = unifiedToSprintId.get(resolvedId);
        if (sprintId) {
          await orchestrator.cancelSprint(sprintId, reason ?? 'cancelled via control plane');
        }
      } catch (err) {
        console.warn('[daemon] onCancel: orchestrator.cancelSprint failed:', err);
      }
      broadcastIFleet(`🛑 /cancel — task \`${resolvedId}\` cancelled${reason ? ` — ${reason}` : ''}.`);
    },
    onPause: async (cmd) => {
      const opts: { reason?: string; by?: string } = {};
      if (cmd.reason) opts.reason = cmd.reason;
      if (cmd.userLabel) opts.by = cmd.userLabel;
      setFleetPaused(opts);
      const info = readPauseInfo();
      broadcastIFleet(
        `⏸ Fleet PAUSED${info.by ? ` by ${info.by}` : ''}${info.reason ? ` — ${info.reason}` : ''}. ` +
          `Running task continues; no new pickups until /continue.`,
      );
    },
    onContinue: async (cmd) => {
      const was = isFleetPaused();
      clearFleetPause();
      if (was) {
        broadcastIFleet(`▶ Fleet RESUMED${cmd.userLabel ? ` by ${cmd.userLabel}` : ''}.`);
      } else {
        broadcastIFleet(`▶ /continue — fleet was not paused${cmd.userLabel ? ` (by ${cmd.userLabel})` : ''}.`);
      }
    },
    onStop: async (cmd) => {
      // (AUDIT-IFleet-7dd1062f) /stop must actually abort running workers,
      // not just flip store state. orchestrator.cancelSprint walks the
      // SprintManager's `running` map and fires each handle.cancel() →
      // PipelineBridge → abortController.abort(). The pipeline runner
      // checks abortSignal between phases (architect/editor/verifier/
      // reviewer) and exits cleanly without producing a PR. Store state
      // and approvalGate.resolve(cancel) are kept for the case where a
      // sprint is queued/planning (not in `running`) — abort is a no-op
      // there, but the state flip still terminates it.
      const reason = cmd.reason ?? 'fleet stopped';
      // Snapshot the running sprints AND the unified→sprint reverse index
      // BEFORE flipping the pause flag (AUDIT-IFleet-07b8a597) and before any
      // await. JS is single-threaded so the synchronous block is atomic with
      // respect to wireSprintCompletion eviction; capturing them here also
      // makes the ordering invariant explicit for future readers.
      const runningSprints = orchestratorStore.listSprintsByStateKind('running');
      // Reverse-index the unified→sprint map so we can find every unified
      // task ID attached to a sprint we're about to cancel. The orchestrator
      // store keys tasks by `tk_<nanoid>` (sprint.ts:170) which is the wrong
      // namespace for both store.updateState and approvalGate.resolve, both
      // of which are keyed by the unified ID. AUDIT-IFleet-b98f11ed,
      // 0920cd46, 0aaad39f.
      const sprintToUnified = new Map<string, string[]>();
      for (const [unifiedId, sprintId] of unifiedToSprintId.entries()) {
        const bucket = sprintToUnified.get(sprintId) ?? [];
        bucket.push(unifiedId);
        sprintToUnified.set(sprintId, bucket);
      }

      // Pause flag last in the synchronous prelude (AUDIT-IFleet-1cdaccd5):
      // the tick loop cannot pick up new work once this is set, and the snapshot
      // above is now stable for the await window below.
      const opts: { reason?: string; by?: string } = { reason: cmd.reason ?? 'STOP' };
      if (cmd.userLabel) opts.by = cmd.userLabel;
      setFleetPaused(opts);

      let cancelledTasks = 0;
      let cancelledSprints = 0;
      const sprintCancels: Promise<unknown>[] = [];
      for (const sprint of runningSprints) {
        try {
          for (const unifiedId of sprintToUnified.get(sprint.id) ?? []) {
            try {
              store.updateState(unifiedId, 'failed', { reason });
            } catch {
              /* unified row may already be terminal — leave it */
            }
            approvalGate.resolve(unifiedId, 'cancel');
            cancelledTasks++;
          }
          cancelledSprints++;
          sprintCancels.push(
            orchestrator.cancelSprint(sprint.id, reason).catch((err: unknown) =>
              console.warn(`[daemon] onStop: cancelSprint ${sprint.id} failed:`, err),
            ),
          );
        } catch (err) {
          console.warn('[daemon] onStop: sprint cancel iteration failed:', err);
        }
      }
      await Promise.allSettled(sprintCancels);
      // Report sprint count (the architectural unit) AND task count so a
      // future multi-brief-per-sprint world stays diagnosable.
      // AUDIT-IFleet-f751e1f1.
      broadcastIFleet(
        `🛑 Fleet STOPPED${cmd.userLabel ? ` by ${cmd.userLabel}` : ''}${cmd.reason ? ` — ${cmd.reason}` : ''}. ` +
          `Aborted ${cancelledSprints} sprint(s) / ${cancelledTasks} task(s); queue paused. ` +
          `Use /continue to resume pickups.`,
      );
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
  // Tracks whether any subsystem reported a failure during shutdown so the
  // process can exit with a non-zero code instead of masking it under exit(0).
  // AUDIT-IFleet-e96f2978.
  let shutdownErrors = 0;
  const tickIntervalMs = Number(process.env['IFLEET_DAEMON_TICK_MS'] ?? DEFAULT_TICK_MS);
  void runTickLoop(
    unified,
    orchestrator,
    () => running,
    tickIntervalMs,
    store,
    discordOut,
    unifiedToSprintId,
    verifierCtx,
  );

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
      shutdownErrors++;
      console.warn('[daemon] approval drain failed:', err);
    }
    try {
      await orchestrator.stop();
    } catch (err) {
      shutdownErrors++;
      console.warn('[daemon] orchestrator.stop failed:', err);
    }
    try {
      await client.destroy();
    } catch (err) {
      shutdownErrors++;
      console.warn('[daemon] client.destroy failed:', err);
    }
    try {
      await cp.stop();
    } catch (err) {
      shutdownErrors++;
      console.warn('[daemon] cp.stop failed:', err);
    }
    try {
      store.close();
    } catch (err) {
      shutdownErrors++;
      console.warn('[daemon] store.close failed:', err);
    }
    // Exit non-zero if any subsystem failed during teardown so PM2 and
    // the operator surface the issue instead of seeing a clean exit code
    // that masks a half-shutdown. AUDIT-IFleet-e96f2978.
    process.exit(shutdownErrors > 0 ? 1 : 0);
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
  out?: DiscordOutAdapter,
  unifiedToSprintId?: Map<string, SprintId>,
  verifierCtx?: TaskContextRegistry,
): Promise<void> {
  let lastPausedAt = false;
  while (isRunning()) {
    try {
      // Honour the fleet PAUSED flag — same flag the smoke runner cron
      // checks at the top of main(). Long-running tasks already in flight
      // are NOT killed; only new pickups are frozen. /stop is the verb that
      // kills + pauses.
      if (isFleetPaused()) {
        if (!lastPausedAt) {
          console.warn('[daemon] fleet PAUSED — skipping pickups until /continue');
          lastPausedAt = true;
        }
        await sleep(tickMs);
        continue;
      }
      if (lastPausedAt) {
        console.warn('[daemon] fleet resumed — pickups re-enabled');
        lastPausedAt = false;
      }
      const task = await adapter.pickNext();
      if (task) {
        const brief = encodeBridgeBrief(task);
        const sprintRec = orchestrator.submitSprint({
          mode: 'normal',
          goal: task.title,
          newTaskBriefs: [brief],
        });
        // Bridge the unified task ID → orchestrator sprint ID so /cancel
        // and /stop (which arrive with the unified ID) can reach the
        // SprintManager. wireSprintCompletion cleans the entry on terminal
        // sprint events.
        unifiedToSprintId?.set(task.id, sprintRec.id);
        // adapter already flipped the row to in_flight inside pickNext().
        // Wire the sprint's terminal event back to the unified queue so the
        // task row transitions out of in_flight (done / failed).
        wireSprintCompletion(
          sprintRec.id,
          task,
          adapter,
          orchestrator,
          store,
          out,
          unifiedToSprintId,
          verifierCtx,
        );
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
 * verdict `'merged'` on success, `'rejected'` on failure/cancel.
 */
function wireSprintCompletion(
  sprintId: string,
  task: import('../contracts/task.js').QueuedTask,
  adapter: UnifiedQueueAdapter,
  orchestrator: Orchestrator,
  store: TaskStore,
  out?: DiscordOutAdapter,
  unifiedToSprintId?: Map<string, SprintId>,
  verifierCtx?: TaskContextRegistry,
): void {
  let lastPrUrl: string | undefined;
  let lastTotalTokens: number | undefined;

  const handler = (event: OrchestratorEvent): void => {
    if (event.sprintId !== sprintId) return;

    if (event.kind === 'task.assigned') {
      // Broadcast the pickup to #ifleet via webhook FIRST — this is the
      // source-agnostic notification. GitHub-source tasks have no thread,
      // so without this they were invisible until completion (or failure).
      // Webhook failures swallow internally; we never lose the event silently
      // (see broadcast-discord.ts warn-once on unset env).
      broadcastIFleet(`🟡 picked up — ${task.repo} · ${task.title}`);
      // Re-read the task from the store: the closure captured the original
      // QueuedTask before discordSource.ingest() opened a thread, so its
      // threadId may be stale (null on the snapshot, populated on the row).
      // Without this re-read, the 🟡 picked-up ping is silently skipped for
      // every task whose thread was created after ingest.
      if (out) {
        const current = store.getById(task.id);
        const threadId =
          current && current.source.kind === 'discord' ? current.source.threadId : undefined;
        if (threadId) {
          void out
            .postProgress(threadId, '🟡 picked up — architect starting')
            .catch(() => {});
        }
      }
      return;
    }

    if (event.kind === 'task.completed') {
      lastPrUrl = event.payload['pr'] as string | undefined;
      lastTotalTokens = event.payload['totalTokens'] as number | undefined;
      // Broadcast PR open to #ifleet via webhook (source-agnostic). Mirror
      // the per-thread post below for Discord-source tasks.
      if (lastPrUrl) {
        broadcastIFleet(`✅ PR opened: ${lastPrUrl} — ${task.repo} · ${task.title}`);
      } else {
        // (AUDIT-IFleet-4d424525) Be explicit about the "no PR" case. The
        // pipeline short-circuits to `already_resolved` / `no_changes_needed`
        // when the editor verified the fix was already in place — that's a
        // success, not a silent failure. Surface that to the operator.
        const reason = (event.payload['failureReason'] as string | undefined) ?? 'no changes needed';
        broadcastIFleet(`✅ task completed — ${task.repo} · ${task.title} (no PR: ${reason})`);
      }
      // Thread-level completion post is owned by Orchestrator.dispatchToDiscord
      // (`out.postCompleted`) which fires on every `task.completed` event for
      // Discord-source tasks with a resolved thread. Posting again here would
      // double the per-thread message. AUDIT-IFleet-b4ad2ed4. The
      // broadcastIFleet ping above is the source-agnostic notification and
      // doesn't duplicate the per-thread post.
      return;
    }

    if (event.kind === 'sprint.completed') {
      orchestrator.off('event', handler);
      unifiedToSprintId?.delete(task.id);

      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          // M4-T5: compute structural fingerprint of the merged diff so
          // PR-rejection learning can detect structural repeats across
          // sprints. Snapshot the verifier ctx BEFORE the delete() below so
          // the async chain sees a worktreePath even if teardown removed
          // the registry entry concurrently. Failure-graceful: any compute
          // throw falls back to null fingerprint and the row is still
          // inserted (per M4-T5 contract).
          const ctx = verifierCtx?.get(task.id);
          void recordPrDecisionMerged(store, task, prNumber, ctx);
        }
      }
      verifierCtx?.delete(task.id);

      void adapter.markCompleted(task, lastPrUrl ?? '', lastTotalTokens).catch((err) =>
        console.warn('[daemon] markCompleted failed:', err),
      );
      return;
    }

    if (event.kind === 'sprint.failed' || event.kind === 'sprint.cancelled') {
      orchestrator.off('event', handler);
      unifiedToSprintId?.delete(task.id);
      // M4-T5: snapshot the verifier ctx BEFORE the cancellation path
      // deletes it below — the fingerprint compute below needs the
      // worktreePath, and sprint.cancelled evicts the registry entry
      // synchronously here.
      const ctxSnapshot = verifierCtx?.get(task.id);
      // `cancelled`: evict immediately — no /force-pr path follows a cancel.
      // `failed`: schedule a delayed eviction (60 min) so the operator's
      // /force-pr call inside that window still resolves repoUrl/branch/
      // worktreePath, but the entry doesn't leak for the life of the daemon.
      // Without the delayed eviction the map grew monotonically across every
      // failed sprint. AUDIT-IFleet-44d12a0d / dae6c0e6.
      if (event.kind === 'sprint.cancelled') {
        verifierCtx?.delete(task.id);
      } else {
        setTimeout(() => verifierCtx?.delete(task.id), 60 * 60 * 1000).unref();
      }
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

      // Broadcast the terminal state to #ifleet via webhook BEFORE markFailed
      // touches the issue — this is the gap that let token-burn go silent.
      // Use the same wire format the smoke runner uses so the channel reads
      // consistently regardless of who dispatched the task.
      const verb = event.kind === 'sprint.cancelled' ? '🛑 cancelled' : '❌ failed';
      broadcastIFleet(`${verb} — ${task.repo} · ${task.title}\n${reason}`);

      // Only record a decision when a PR was opened before the failure/cancel.
      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          // M4-T5: sprint.failed/cancelled with a PR open => the PR was
          // closed without merging => verdict='rejected'. Same async
          // fingerprint compute as the merged path; null on any failure.
          void recordPrDecisionRejected(store, task, prNumber, ctxSnapshot);
        }
      }

      void adapter.markFailed(task, reason).catch((err) =>
        console.warn('[daemon] markFailed failed:', err),
      );
    }
  };

  orchestrator.on('event', handler);
}

/**
 * Read the structural fingerprint that {@link wrapFactoryWithVerifierContext}'s
 * teardown wrapper cached on the registry. M4-T6 moved the compute upstream
 * because the worktree is gone by the time sprint.completed/failed/cancelled
 * fires — recomputing here would always return null in production. The
 * graceful-failure contract carries over: a missing ctx, an unset fingerprint
 * (teardown hook never ran), or a recorded `null` (compute attempted and
 * failed) all flow through as `null` so the caller still inserts the row
 * with verdict + fingerprint=null.
 */
function readCachedFingerprint(
  ctx: { fingerprint?: string | null } | undefined,
): string | null {
  return ctx?.fingerprint ?? null;
}

function recordPrDecisionMerged(
  store: TaskStore,
  task: import('../contracts/task.js').QueuedTask,
  prNumber: number,
  ctx: { fingerprint?: string | null } | undefined,
): void {
  const fingerprint = readCachedFingerprint(ctx);
  try {
    store.insertPrDecisionWithFingerprint({
      id: `prd_${randomUUID()}`,
      taskId: task.id,
      repo: task.repo,
      prNumber,
      verdict: 'merged',
      reviewerLogin: null,
      mergedAt: Date.now(),
      fingerprint,
    });
  } catch (err) {
    console.warn('[daemon] insertPrDecisionWithFingerprint(merged) failed:', err);
  }
}

function recordPrDecisionRejected(
  store: TaskStore,
  task: import('../contracts/task.js').QueuedTask,
  prNumber: number,
  ctx: { fingerprint?: string | null } | undefined,
): void {
  const fingerprint = readCachedFingerprint(ctx);
  try {
    store.insertPrDecisionWithFingerprint({
      id: `prd_${randomUUID()}`,
      taskId: task.id,
      repo: task.repo,
      prNumber,
      verdict: 'rejected',
      reviewerLogin: null,
      fingerprint,
    });
  } catch (err) {
    console.warn('[daemon] insertPrDecisionWithFingerprint(rejected) failed:', err);
  }
}

interface TaskContextRecord {
  repoUrl: string;
  branch: string;
  worktreePath: string;
  sha?: string;
  // M4-T6: cached structural fingerprint computed at teardown time, while
  // the worktree still exists. Read at sprint.completed/failed/cancelled
  // event time (after the worktree is gone). `null` means compute was
  // attempted and failed; `undefined` means it never ran (treat as null).
  fingerprint?: string | null;
}

export class TaskContextRegistry {
  // Records are stored once under a primary key (the orchestrator's `tk_*`
  // task ID) and exposed via secondary aliases (the unified queue ID — Discord
  // ULID or GitHub node_id). `get`/`setSha`/`delete` resolve aliases first so
  // either ID namespace returns the same record. Closes AUDIT-IFleet-57f5d4e8.
  private readonly map = new Map<string, TaskContextRecord>();
  private readonly aliasToPrimary = new Map<string, string>();

  record(taskId: string, rec: TaskContextRecord, alias?: string): void {
    this.map.set(taskId, rec);
    if (alias && alias !== taskId) this.aliasToPrimary.set(alias, taskId);
  }
  setSha(taskId: string, sha: string): void {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const r = this.map.get(primary);
    if (r) r.sha = sha;
  }
  /**
   * M4-T6: stash the structural fingerprint that {@link wrapFactoryWithVerifierContext}'s
   * teardown wrapper computed against the live worktree. Resolves aliases like
   * setSha. Setting `null` is meaningful: it records "compute was attempted and
   * failed", which lets the wiring layer distinguish from `undefined` (the
   * teardown hook never ran — e.g. a synthetic test setup).
   */
  setFingerprint(taskId: string, fingerprint: string | null): void {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const r = this.map.get(primary);
    if (r) r.fingerprint = fingerprint;
  }
  get(taskId: string): TaskContextRecord | undefined {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    return this.map.get(primary);
  }
  /**
   * Evict on terminal sprint state. Without this the map grows monotonically
   * for the life of the 24/7 daemon — every processed task adds one entry
   * that's never reclaimed. AUDIT-IFleet-4aed4b1e / 8c9e1b6f / 3d7f47c3 / 4c20a0e6.
   *
   * Accepts either the primary `tk_*` ID or any alias — removes the record
   * and every alias pointing at it.
   */
  delete(taskId: string): boolean {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const existed = this.map.delete(primary);
    for (const [alias, target] of this.aliasToPrimary.entries()) {
      if (target === primary) this.aliasToPrimary.delete(alias);
    }
    return existed;
  }
  /** Test helper — current entry count (primary keys only). */
  size(): number { return this.map.size; }
}

export function wrapFactoryWithVerifierContext(
  inner: PipelineRunnerFactory,
  registry: TaskContextRegistry,
): PipelineRunnerFactory {
  return async (taskId, brief, opts): Promise<PipelineRunBootstrap> => {
    const bootstrap = await inner(taskId, brief, opts);
    const task = decodeBridgeBrief(brief);
    if (task) {
      // Alias the unified queue ID (Discord ULID / GitHub node_id) to the
      // orchestrator's `tk_*` primary key so callbacks that arrive with the
      // unified ID (onForcePr, wireSprintCompletion's verifierCtx.delete) can
      // resolve the same record. AUDIT-IFleet-57f5d4e8.
      registry.record(
        taskId,
        {
          repoUrl: `https://github.com/${task.repo}`,
          branch: titleToBranchName(task.issueNumber, task.title),
          worktreePath: bootstrap.input.worktreePath,
        },
        task.id,
      );
    }
    const origTeardown = bootstrap.teardown;
    // Capture HEAD SHA AND structural fingerprint before the inner teardown
    // removes the worktree. wireSprintCompletion reads both at sprint.completed
    // /failed/cancelled time, but those events fire AFTER teardown — so the
    // compute MUST happen here, while the worktree still exists. M4-T6.
    bootstrap.teardown = async (result) => {
      let headSha: string | null = null;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: bootstrap.input.worktreePath,
        });
        headSha = stdout.trim();
        registry.setSha(taskId, headSha);
      } catch { /* missing worktree → resolver returns null, verifier skips */ }
      if (headSha) {
        try {
          // baseRef='main' is safe: production worktrees are always created from main
          // by buildWorkerPool (factory.ts:324 `git worktree add ... main`). AUDIT-IFleet-0c47bae9.
          const fp = await computeStructuralFingerprint({
            repoRoot: bootstrap.input.worktreePath,
            baseRef: 'main',
            headRef: headSha,
          });
          registry.setFingerprint(taskId, fp.sha256);
        } catch (err) {
          console.warn('[daemon] teardown-time computeStructuralFingerprint failed:', err);
          console.warn('[daemon] teardown-time fingerprint=null for task ' + taskId + ' (baseRef=main, headSha=' + headSha + ')');
          registry.setFingerprint(taskId, null);
        }
      } else {
        console.warn('[daemon] teardown-time fingerprint=null for task ' + taskId + ' (baseRef=main, headSha=unknown)');
        registry.setFingerprint(taskId, null);
      }
      if (origTeardown) await origTeardown(result);
    };
    return bootstrap;
  };
}

/**
 * Dependencies for {@link handleForcePr}. `execFile` and `broadcast` default
 * to the module-level production wiring; tests inject stubs.
 */
export interface ForcePrDeps {
  store: TaskStore;
  orchestratorStore: StateStore;
  unifiedToSprintId: Map<string, SprintId>;
  verifierCtx: TaskContextRegistry;
  octokit: Pick<Octokit, 'rest'>;
  execFile?: typeof execFileAsync;
  broadcast?: (msg: string) => void;
}

type ForcePrPushOutcome = 'success' | 'already-up-to-date' | 'failed';

/**
 * Operator override handler. Logs the deliberate verifier bypass into the
 * events table, pushes the task's branch to origin, and opens a PR via the
 * Octokit client.
 *
 * Push outcomes (AUDIT-IFleet-c9d0e1f2):
 *   - success: branch pushed, proceed to pulls.create
 *   - already-up-to-date: branch already at this SHA on origin (benign,
 *     git exits 0 with "Everything up-to-date"), proceed to pulls.create
 *   - failed: real push error (auth, network, branch protection, worktree
 *     gone) — abort the force-PR and tell the operator via broadcastIFleet.
 *     Do NOT call pulls.create, which would emit a misleading "PR may
 *     already exist" message when the real cause is upstream of PR creation
 *     entirely.
 *
 * Extracted from the inline onForcePr callback so the push-outcome branches
 * can be exercised in unit tests without booting the daemon.
 */
export async function handleForcePr(
  taskId: string,
  reason: string | undefined,
  deps: ForcePrDeps,
): Promise<void> {
  const {
    store,
    orchestratorStore,
    unifiedToSprintId,
    verifierCtx,
    octokit,
    execFile = execFileAsync,
    broadcast = broadcastIFleet,
  } = deps;
  let sprintId: SprintId | undefined;
  try {
    const unified = store.getById(taskId);
    sprintId = unifiedToSprintId.get(taskId);
    if (sprintId) {
      orchestratorStore.appendEvent({
        ts: Date.now(),
        sprintId,
        taskId: taskId as TaskId,
        kind: 'verifier.force_pr',
        payload: { reason: reason ?? null },
      });
    } else {
      const tk = orchestratorStore.loadTask(taskId as TaskId);
      if (tk) {
        sprintId = tk.sprintId;
        orchestratorStore.appendEvent({
          ts: Date.now(),
          sprintId: tk.sprintId,
          taskId: tk.id,
          kind: 'verifier.force_pr',
          payload: { reason: reason ?? null },
        });
      }
    }
    const ctx = verifierCtx.get(taskId);
    if (!ctx) {
      console.warn(
        `[daemon] onForcePr(${taskId}): no branch context in TaskContextRegistry — audit event logged but PR not opened`,
      );
      return;
    }
    const repoSlug = ctx.repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const [owner, repo] = repoSlug.split('/', 2);
    if (!owner || !repo) {
      console.warn(
        `[daemon] onForcePr(${taskId}): could not parse owner/repo from ${ctx.repoUrl}`,
      );
      return;
    }
    const title = unified?.title ?? `Force-PR for ${taskId}`;
    const body =
      `Force-PR override dispatched via Discord.\n\n` +
      `- Task: \`${taskId}\`\n` +
      `- Reason: \`${(reason ?? '(none)').replace(/`/g, "'")}\`\n` +
      `- Verifier status: \`failed\` (deliberate operator bypass)\n`;
    // Push the branch first — onForcePr can fire from a failed-verifier
    // worktree that the normal PR path never reached, so origin may not
    // have the head yet. Three outcomes:
    //   - success: branch pushed, proceed to pulls.create
    //   - already-up-to-date: branch already at this SHA on origin (benign),
    //     proceed to pulls.create
    //   - failed: real push error (auth, network, branch protection, worktree
    //     gone) — abort the force-PR and tell the operator. Do NOT call
    //     pulls.create, which would emit a misleading "PR may already exist"
    //     message when the real cause is upstream of PR creation entirely.
    // (AUDIT-IFleet-c9d0e1f2 closed by this change.)
    let pushOutcome: ForcePrPushOutcome = 'success';
    let pushErrorMessage = '';
    try {
      const { stdout, stderr } = await execFile(
        'git',
        ['push', '-u', 'origin', ctx.branch],
        { cwd: ctx.worktreePath },
      );
      if (
        /Everything up-to-date/i.test(stderr ?? '') ||
        /Everything up-to-date/i.test(stdout ?? '')
      ) {
        pushOutcome = 'already-up-to-date';
      }
    } catch (pushErr) {
      pushOutcome = 'failed';
      pushErrorMessage = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.warn(
        `[daemon] onForcePr(${taskId}): git push failed, aborting force-PR: ${pushErrorMessage}`,
      );
    }
    if (pushOutcome === 'failed') {
      if (sprintId) {
        try {
          orchestratorStore.appendEvent({
            ts: Date.now(),
            sprintId,
            taskId: taskId as TaskId,
            kind: 'verifier.force_pr_aborted',
            payload: { reason: reason ?? null, cause: 'push_failed', error: pushErrorMessage },
          });
        } catch (err) {
          console.warn('[daemon] onForcePr abort event append failed:', err);
        }
      }
      const abortMsg =
        `⛔ /force-pr ABORTED — \`${taskId}\` — \`git push origin ${ctx.branch}\` failed; PR NOT opened. ` +
        `Reason: \`${(reason ?? '(none)').replace(/`/g, "'")}\`. ` +
        `Recovery: investigate push failure (auth, network, branch protection, worktree state), then retry /force-pr if appropriate. ` +
        `Push error: ${pushErrorMessage || '(no message)'}`;
      try {
        broadcast(abortMsg);
      } catch (err) {
        console.warn('[daemon] onForcePr abort broadcast failed:', err);
      }
      return;
    }
    // Use the existing Octokit client (already authenticated with
    // GITHUB_TOKEN) instead of shelling to `gh`, which isn't installed on
    // the VPS daemon image. AUDIT-IFleet-63347c06.
    try {
      await octokit.rest.pulls.create({
        owner,
        repo,
        base: 'main',
        head: ctx.branch,
        title,
        body,
      });
    } catch (err) {
      console.warn(
        `[daemon] onForcePr(${taskId}): pulls.create failed (PR may already exist): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } catch (err) {
    console.warn('[daemon] onForcePr append failed:', err);
  }
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

// AUDIT-IFleet-1b8126b6 / dc8a89c5 / c29996f1 — minimal sanity-check on
// worker model IDs from BOTH bootstrap paths: the WORKER_MODELS env var
// (dot-separated aliases like `opus-4.7`) and config/workers.json (full
// model IDs like `claude-opus-4-7`). Unknown values are still allowed
// (forward-compatibility with new models) but emit a one-line warn so a
// typo like "sonet-4.6" surfaces immediately at boot instead of failing
// opaquely at account-pool resolution.
const KNOWN_MODEL_SHORTHAND = new Set([
  // Short aliases (WORKER_MODELS env var)
  'opus-4.7', 'sonnet-4.6', 'haiku-4.5',
  // Full model IDs (config/workers.json)
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
]);

function warnUnknownModels(source: string, models: ReadonlyArray<string>): void {
  for (const m of models) {
    if (!KNOWN_MODEL_SHORTHAND.has(m)) {
      console.warn(
        `[daemon] ${source} contains unknown model id: \`${m}\` ` +
          `(known: ${Array.from(KNOWN_MODEL_SHORTHAND).join(', ')}). ` +
          `Forwarding to pool anyway; verify pipeline factory mapModel() supports it.`,
      );
    }
  }
}

function loadInitialWorkers(configPath?: string): ReadonlyArray<WorkerConfig> {
  // Preferred bootstrap path: read config/workers.json so the initial value
  // matches the live config without hardcoding model versions in source code.
  // AUDIT-IFleet-df1f3730 / 3ea3e721.
  if (configPath) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { workers?: ReadonlyArray<WorkerConfig> };
      const enabled = (parsed.workers ?? []).filter((w) => w.enabled);
      if (enabled.length > 0) {
        for (const w of enabled) {
          warnUnknownModels(`workers.json[${w.id}].models`, w.models ?? []);
        }
        return enabled;
      }
      // AUDIT-IFleet-1543b30a — surface the silent fall-through when the
      // config file exists but every worker is disabled. Without this warn
      // the operator only learns from boot-time worker counts that the
      // config wasn't honored.
      console.warn(
        `[daemon] loadInitialWorkers: ${configPath} has no enabled workers ` +
          `— falling back to env / hardcoded bootstrap`,
      );
    } catch (err) {
      console.warn(
        `[daemon] loadInitialWorkers: could not read ${configPath} (${
          err instanceof Error ? err.message : String(err)
        }); falling back to env / hardcoded bootstrap`,
      );
    }
  }
  // Fallback: WORKER_MODELS env var, then a single-account hardcoded bootstrap.
  // The orchestrator's WorkerRegistry watches config/workers.json and reloads
  // on change, so this fallback only survives until the file appears.
  const modelsEnv = process.env['WORKER_MODELS'];
  const models = modelsEnv
    ? modelsEnv
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    : ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'];
  warnUnknownModels('WORKER_MODELS', models);
  const cfg: WorkerConfig = {
    id: 'claude-max-1',
    provider: 'claude',
    authProfile: process.env['CLAUDE_AUTH_PROFILE'] ?? 'default',
    models,
    maxConcurrent: 1,
    enabled: true,
  };
  return [cfg];
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
