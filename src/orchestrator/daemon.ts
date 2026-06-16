// IFleet daemon entry point — PM2 app `ifleet`.
// Wires: TaskStore, FileChannelRouter, Discord client, DiscordOutAdapter,
// ControlPlane HTTP listener, UnifiedQueueAdapter → Orchestrator tick loop.
// Handler modules under ./handlers/ own all the logic; this file owns the boot
// sequence, graceful shutdown, and re-exports for backward compat.
// Run: `pnpm start:daemon` or via PM2.

import { resolve as resolvePath } from 'node:path';
import type { Client } from 'discord.js';
import { Octokit } from '@octokit/rest';
import { VerifierController } from '../agents/verifier/controller.js';
import { loadReposConfig } from '../config/repos.js';
import { registerProposerDiscordClient } from '../agents/proposer/approval-gate.js';
import { createDiscordClient } from '../discord/client.js';
import { HmacControlPlaneClient } from '../discord/hmac-client.js';
import { DiscordOutAdapter } from '../observability/discord-output.js';
import { makeProductionFactory } from '../pipeline/factory.js';
import { createControlPlane } from '../queue/control-plane.js';
import { GitHubQueue } from '../queue/github.js';
import { GitHubIssuesSource } from '../queue/sources/github.js';
import { DiscordSource } from '../queue/sources/discord.js';
import { TaskStore, defaultTasksDbPath } from '../queue/store.js';
import type { QueueAdapter } from '../queue/types.js';
import { UnifiedQueueAdapter } from '../queue/unified-adapter.js';
import { FileChannelRouter } from '../repos/router.js';
import { requireEnv } from '../utils/env.js';
import type { SprintId, TaskId } from './types.js';
import { Orchestrator } from './index.js';
import { ControlPlaneApprovalGate } from './approval-gate.js';
import { StateStore } from './store.js';
import { buildControlPlaneOptions } from './handlers/control-plane.js';
import { runTickLoop } from './handlers/sprint-bridge.js';
import {
  TaskContextRegistry,
  resolveVerifierContext,
  wrapFactoryWithVerifierContext,
  wrapFactoryWithApprovalAndEmit,
  persistPipelineEvent,
  discordOutPlanReady,
} from './handlers/pr-decisions.js';
import { loadInitialWorkers, buildRepoResolver } from './handlers/boot-config.js';

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
  const store = new TaskStore(defaultTasksDbPath());
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
        console.error('[daemon] discord.post_failed event append threw:', err);
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
  // Compose a RepoResolver from channels.json (workDir + defaultBranch +
  // codeowners) and repos.json (allowed repos). The factory uses this to
  // refuse any task whose `task.repo` is not whitelisted, before a worktree
  // is created or any git/PR command runs. AUDIT-IFleet-6126a1f9.
  const repoResolver = buildRepoResolver(router, reposMap);
  const productionFactory = makeProductionFactory({
    repoResolver,
    octokit,
    initialWorkers,
    taskStore: store,
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

  const discordOutbox = store.createDiscordOutbox();

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
    discordOutbox,
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
    ...buildControlPlaneOptions({
      store,
      orchestratorStore,
      approvalGate,
      discordSource,
      orchestrator,
      verifierController,
      verifierCtx,
      unifiedToSprintId,
      octokit,
    }),
  });

  await cp.start();
  console.warn(`[daemon] control plane listening on ${controlPlaneUrl}`);

  // -------- Boot Discord client --------
  await client.login(discordToken);
  console.warn('[daemon] discord client logged in');
  registerProposerDiscordClient(client);

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
      console.error('[daemon] approval drain failed:', err);
    }
    try {
      await orchestrator.stop();
    } catch (err) {
      shutdownErrors++;
      console.error('[daemon] orchestrator.stop failed:', err);
    }
    try {
      await client.destroy();
    } catch (err) {
      shutdownErrors++;
      console.error('[daemon] client.destroy failed:', err);
    }
    try {
      await cp.stop();
    } catch (err) {
      shutdownErrors++;
      console.error('[daemon] cp.stop failed:', err);
    }
    try {
      store.close();
    } catch (err) {
      shutdownErrors++;
      console.error('[daemon] store.close failed:', err);
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
 * Legacy QueueAdapter shim — ControlPlaneOptions still requires one for the
 * `cancel`/`status` paths. The daemon's onCancel callback handles state
 * transitions via the unified store, so the legacy methods only need to
 * exist; their bodies are intentionally no-ops here.
 */
function legacyQueueShim(_legacy: GitHubQueue): QueueAdapter {
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

// CLI entry: invoked when this module is the node entrypoint.
const isEntry =
  typeof process.argv[1] === 'string' && /daemon\.(ts|js|mjs)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    console.error('[daemon] fatal:', err);
    process.exit(1);
  });
}

// Re-exports for backward compatibility — tests and external callers import
// these symbols from '../daemon'; they now live in the handler modules.
export {
  TaskContextRegistry,
  wrapFactoryWithVerifierContext,
  wrapFactoryWithApprovalAndEmit,
  resolveVerifierContext,
  persistPipelineEvent,
} from './handlers/pr-decisions.js';
export type { ForcePrDeps } from './handlers/pr-decisions.js';
export { handleForcePr } from './handlers/pr-decisions.js';
export { runTickLoop, wireSprintCompletion } from './handlers/sprint-bridge.js';
export { buildRepoResolver, loadInitialWorkers } from './handlers/boot-config.js';
export { main as runDaemon };
