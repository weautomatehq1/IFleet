/**
 * PM2 cron entry for the verifier-disagreement canary alerter.
 *
 * Cron in `ecosystem.config.cjs` fires this every hour. It reads the
 * disagreement rate from the orchestrator SQLite store, compares against
 * `IFLEET_CANARY_THRESHOLD` (default 0.25), and posts to the Discord
 * channel in `IFLEET_OPS_CHANNEL_ID` ONLY on transitions (dedup).
 *
 * Required env (production):
 *   DISCORD_BOT_TOKEN          — bot token, posts as the bot
 *   IFLEET_OPS_CHANNEL_ID      — channel for ops alerts (#ifleet-ops)
 *
 * Optional env:
 *   IFLEET_CANARY_ALERTING_ENABLED — "1" to actually run (default off)
 *   IFLEET_CANARY_THRESHOLD        — float, default 0.25
 *   IFLEET_CANARY_WINDOW_DAYS      — int, default 7
 *   IFLEET_STATE_DB                — absolute path to state.db
 *                                    (default: resolved from StateStore default)
 *   IFLEET_CANARY_STATE_PATH       — alert state file
 *                                    (default: .ifleet/canary/alert-state.json)
 *
 * Manual trigger (development):
 *   IFLEET_CANARY_ALERTING_ENABLED=1 \
 *     DISCORD_BOT_TOKEN=... \
 *     IFLEET_OPS_CHANNEL_ID=... \
 *     node --import tsx scripts/canary-alert.ts
 */

import { Client, GatewayIntentBits, type TextChannel } from 'discord.js';
import { resolve } from 'node:path';
import { StateStore } from '../src/orchestrator/store.js';
import { VerifierStoreBridge } from '../src/agents/verifier/store-bridge.js';
import { CanaryStateStore } from '../src/agents/canary/state-store.js';
import {
  DEFAULT_DISAGREEMENT_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  runCanaryAlert,
} from '../src/agents/canary/alert.js';

function parseNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[canary] env ${key}=${raw} is not a finite number — using fallback ${fallback}`);
    return fallback;
  }
  return value;
}

async function postToChannel(channelId: string, token: string, message: string): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await new Promise<void>((resolveFn, rejectFn) => {
      client.once('ready', () => {
        client.channels
          .fetch(channelId)
          .then((channel) => {
            if (!channel || !('send' in channel)) {
              throw new Error(`channel ${channelId} is not a text channel`);
            }
            return (channel as TextChannel).send(message);
          })
          .then(() => resolveFn())
          .catch(rejectFn);
      });
    });
  } finally {
    await client.destroy();
  }
}

async function main(): Promise<void> {
  if (process.env['IFLEET_CANARY_ALERTING_ENABLED'] !== '1') {
    console.warn('[canary] IFLEET_CANARY_ALERTING_ENABLED != 1 — skipping.');
    return;
  }

  const token = process.env['DISCORD_BOT_TOKEN'];
  const channelId = process.env['IFLEET_OPS_CHANNEL_ID'];
  if (!token || !channelId) {
    console.warn('[canary] DISCORD_BOT_TOKEN or IFLEET_OPS_CHANNEL_ID missing — skipping.');
    return;
  }

  const threshold = parseNumberEnv('IFLEET_CANARY_THRESHOLD', DEFAULT_DISAGREEMENT_THRESHOLD);
  const windowDays = parseNumberEnv('IFLEET_CANARY_WINDOW_DAYS', DEFAULT_WINDOW_DAYS);

  const dbPath = process.env['IFLEET_STATE_DB']
    ? resolve(process.env['IFLEET_STATE_DB'])
    : resolve(process.cwd(), '.ifleet/state.db');
  const store = new StateStore(dbPath);
  try {
    const bridge = new VerifierStoreBridge(store);
    const canaryState = new CanaryStateStore(
      process.env['IFLEET_CANARY_STATE_PATH']
        ? { path: process.env['IFLEET_CANARY_STATE_PATH'] }
        : {},
    );

    const evaluation = await runCanaryAlert({
      bridge,
      store: canaryState,
      threshold,
      windowDays,
      inspectionHint: 'sqlite> SELECT id, task_id, status, started_at FROM verifier_runs WHERE status=\'failed\' ORDER BY started_at DESC LIMIT 20;',
      postAlert: (text) => postToChannel(channelId, token, text),
    });

    console.warn(
      `[canary] transition=${evaluation.transition} reason=${evaluation.reason} ` +
        `rate=${evaluation.snapshot.rate} total=${evaluation.snapshot.total} ` +
        `failed=${evaluation.snapshot.failed}`,
    );
  } finally {
    store.close();
  }
}

const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('canary-alert.ts') || arg.endsWith('canary-alert.js');
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('[canary] failed:', err);
    process.exit(1);
  });
}
