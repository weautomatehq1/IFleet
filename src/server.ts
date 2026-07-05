/**
 * HTTP entry for the public IFleet ControlPlane (PM2 app `control-plane`).
 *
 * Responsibilities:
 *   - Accept HMAC-signed POSTs to /control from the Discord bot (running
 *     inside the `ifleet` daemon) or any future external integration.
 *   - Ingest sprint_goal commands into the unified TaskStore via
 *     {@link DiscordSource} so the daemon can pick them up.
 *   - Translate approve/cancel commands into store state transitions.
 *
 * Thread / progress posting for picked-up tasks happens in the daemon
 * process (see src/orchestrator/daemon.ts) because the discord.js Client
 * (one singleton WS connection) lives there. This entry uses a deferring
 * DiscordOut that logs without touching Discord — DiscordSource's threadId
 * is filled in when the daemon picks the task up.
 *
 * Required env:
 *   IFLEET_HMAC_SECRET   — shared with the Discord bot (daemon process)
 *   IFLEET_STATE_DIR     — defaults to ./state, /opt/ifleet/state on VPS
 *   CONTROL_PLANE_PORT   — defaults to 3001
 *   IFLEET_CHANNELS_PATH — defaults to config/channels.json
 *
 * Run: `pnpm start:control-plane`
 */

import { resolve as resolvePath, join } from 'node:path';
import { createControlPlane, UnsupportedCommandError } from './queue/control-plane.js';
import { DiscordSource } from './queue/sources/discord.js';
import { TaskStore, defaultTasksDbPath } from './queue/store.js';
import { FileChannelRouter } from './repos/router.js';
import type { QueueAdapter } from './queue/types.js';
import type { ChannelRouter } from './contracts/channel-router.js';
import type { DiscordOut } from './contracts/discord-out.js';

export interface ServerDeps {
  /** Optional — defaults to an open TaskStore on IFLEET_STATE_DIR. */
  store?: TaskStore;
  /** Tests can override. Production reads config/channels.json. */
  router?: ChannelRouter;
  /** Tests can override. Production uses {@link deferringDiscordOut}. */
  discordOut?: DiscordOut;
  /** Override env reads — useful for tests. */
  env?: Record<string, string | undefined>;
}

export interface RunningServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
  store: TaskStore;
}

export async function startServer(deps: ServerDeps = {}): Promise<RunningServer> {
  const env = deps.env ?? process.env;
  const secret = env['IFLEET_HMAC_SECRET'];
  if (!secret) throw new Error('IFLEET_HMAC_SECRET is required');

  const port = Number(env['CONTROL_PLANE_PORT'] ?? 3001);
  const store = deps.store ?? new TaskStore(
    env['IFLEET_STATE_DIR'] ? join(env['IFLEET_STATE_DIR'], 'tasks.db') : defaultTasksDbPath(),
  );

  // Crash-recovery sweep: any task left `in_flight` past the threshold (30
  // min default) is treated as orphaned and reset to `pending` so the daemon
  // can re-pick it. Safe to call before the daemon connects because pending
  // is the resting state.
  const recovered = store.recoverStale();
  if (recovered > 0) {
    console.warn(`[control-plane] recovered ${recovered} stale in_flight task(s)`);
  }

  const router = deps.router ?? loadRouter(env);
  const discordOut = deps.discordOut ?? deferringDiscordOut();
  const queue = noopQueue();

  const discordSource = new DiscordSource({ router, out: discordOut });

  // Persistent replay-protection ledger. Survives PM2 restart so a captured
  // signed request can't be replayed inside the maxSkewSec window after the
  // process boots back up (AUDIT-IFleet-e664f9f3).
  const DEFAULT_MAX_SKEW_SEC = 5 * 60;
  const NONCE_TTL_PADDING_SEC = 60;
  const nonceLedger = store.createNonceLedger(
    (DEFAULT_MAX_SKEW_SEC + NONCE_TTL_PADDING_SEC) * 1000,
  );

  const cp = createControlPlane({
    queue,
    hmacSecret: secret,
    port,
    nonceLedger,
    onSprintGoal: async (cmd) => {
      // messageId is optional — slash commands provide idempotencyKey instead.
      // DiscordSource.ingest() requires either messageId or idempotencyKey for
      // dedup; we validate that at least one is present here and let ingest()
      // derive the idempotencyKey from messageId when it's the only one given
      // (AUDIT-IFleet-4b7622ff).
      if (!cmd.channelId || !cmd.userId || !cmd.userLabel) {
        throw new Error('sprint_goal from server requires channelId, userId, userLabel');
      }
      if (!cmd.messageId && !cmd.idempotencyKey) {
        throw new Error('sprint_goal from server requires either messageId or idempotencyKey');
      }
      const task = await discordSource.ingest(
        {
          goal: cmd.goal,
          channelId: cmd.channelId,
          ...(cmd.messageId ? { messageId: cmd.messageId } : {}),
          userId: cmd.userId,
          userLabel: cmd.userLabel,
          idempotencyKey: cmd.idempotencyKey,
          planOnly: cmd.planOnly,
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
    onRun: () => {
      // Daemon's tick loop picks from the store; no-op here.
    },
    onApprove: async (taskId) => {
      // approve requires the in-process ControlPlaneApprovalGate that only the
      // daemon owns (pure in-memory; no DB polling). Throw so the caller gets
      // 422 with routing info rather than a silent 202 that never unblocks the
      // architect (AUDIT-IFleet-ef85fec7).
      throw new UnsupportedCommandError(
        `approve(${taskId}) is daemon-only on this port`,
        `CONTROL_PLANE_PORT (daemon port)`,
      );
    },
    onCancel: async (taskId, reason) => {
      // Partial action only: marks the task blocked in the store, but does NOT
      // abort the in-flight pipeline worker. The worker keeps running until its
      // own timeout because the AbortController + ApprovalGate wiring lives
      // exclusively in the daemon (port 3002). Route cancel to CONTROL_PLANE_PORT
      // 3002 for full cancellation. AUDIT-IFleet-c841a3e8.
      console.error(
        `[control-plane] cancel(${taskId}) on public port: store marked blocked but running pipeline NOT killed — route to CONTROL_PLANE_PORT 3002 for full cancellation`,
      );
      store.updateState(taskId, 'blocked', { reason: reason ?? 'cancelled', cancelled: true });
    },
    // verify / force_pr require the in-process verifier + orchestrator wiring
    // that only the daemon owns. Throw UnsupportedCommandError so the caller
    // receives 422 with routing info rather than a silent 202 (AUDIT-IFleet-ef85fec7).
    onVerify: async (taskId) => {
      throw new UnsupportedCommandError(
        `verify(${taskId}) is daemon-only on this port`,
        `CONTROL_PLANE_PORT (daemon port)`,
      );
    },
    onForcePr: async (taskId) => {
      throw new UnsupportedCommandError(
        `force_pr(${taskId}) is daemon-only on this port`,
        `CONTROL_PLANE_PORT (daemon port)`,
      );
    },
    onStatus: () => null,
  });

  await cp.start();
  const url = `http://127.0.0.1:${port}`;
  console.warn(`[control-plane] listening on ${url}`);

  const shutdown = async (): Promise<void> => {
    console.warn('[control-plane] shutting down');
    await cp.stop();
    store.close();
  };
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));

  return { url, port, store, stop: shutdown };
}

function loadRouter(env: Record<string, string | undefined>): ChannelRouter {
  const path =
    env['IFLEET_CHANNELS_PATH'] ?? resolvePath(process.cwd(), 'config', 'channels.json');
  try {
    return FileChannelRouter.fromFile(path);
  } catch (err) {
    if (env['NODE_ENV'] === 'production') {
      throw new Error(
        `[control-plane] FileChannelRouter.fromFile(${path}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    console.warn(
      `[control-plane] no channels file at ${path} — using empty router (DEV only)`,
    );
    return { resolve: () => null, list: () => [] };
  }
}

/**
 * DiscordOut implementation that logs but never touches Discord. The public
 * control-plane writes tasks to the store; the daemon process (which holds
 * the singleton discord.js Client) posts the thread when it picks the task
 * up. Avoids a second Discord WS connection per host.
 */
function deferringDiscordOut(): DiscordOut {
  return {
    postTaskCreated: async (task) => {
      console.warn(`[control-plane] task ${task.id} queued (thread deferred to daemon)`);
      return { threadId: '' };
    },
    postProgress: async () => undefined,
    postPlanForApproval: async () => ({ messageId: '' }),
    postCompleted: async () => undefined,
    postFailed: async () => undefined,
    postChannelMessage: async () => undefined,
  };
}

function noopQueue(): QueueAdapter {
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

// Run as entry point when invoked directly.
const invokedAsScript =
  typeof process.argv[1] === 'string' && /server\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedAsScript) {
  startServer().catch((err) => {
    console.error('[control-plane] failed to start:', err);
    process.exit(1);
  });
}
