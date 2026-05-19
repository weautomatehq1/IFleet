// discord-bot entry point — PM2 app `discord-bot` runs this.
//
// Required env vars (load from /etc/environment on VPS, .env locally):
//   DISCORD_BOT_TOKEN     — bot token from the Discord developer portal
//   DISCORD_CLIENT_ID     — application id (used by scripts/deploy-commands.ts only)
//   DISCORD_GUILD_ID      — weautomatehq guild id (deploy-commands only)
//   CONTROL_PLANE_URL     — e.g. http://localhost:3001/control
//   IFLEET_HMAC_SECRET    — must match T2's server-side secret
//
// Responsibilities (T1 scope):
//   - Hold the discord.js singleton and wire event handlers
//   - Convert Discord events → HMAC-signed POSTs to ControlPlane (T2)
//   - Resolve channel → repo via ChannelRouter (T4)
//   - Defer output formatting to DiscordOut (T5)
//
// This file deliberately does NOT spawn `claude`, touch the queue, or do any
// task logic. Cross-boundary edits are forbidden by MASTER.md.

import { createDiscordClient } from './client.js';
import { HmacControlPlaneClient } from './hmac-client.js';
import type { ChannelRouter } from '../contracts/channel-router.js';
import type { ReactionDeps } from './handlers/reaction-add.js';

export interface DiscordBootstrap {
  router: ChannelRouter;
  resolveTaskIdFromMessage?: ReactionDeps['resolveTaskIdFromMessage'];
}

/** Programmatic entry — production wires router + T5 lookup here. */
export async function startDiscordBot(bootstrap: DiscordBootstrap): Promise<() => Promise<void>> {
  const token = requireEnv('DISCORD_BOT_TOKEN');
  const url = process.env['CONTROL_PLANE_URL'] ?? 'http://localhost:3001/control';
  const secret = requireEnv('IFLEET_HMAC_SECRET');

  const controlPlane = new HmacControlPlaneClient({ url, secret });
  const client = createDiscordClient({
    router: bootstrap.router,
    controlPlane,
    ...(bootstrap.resolveTaskIdFromMessage
      ? { resolveTaskIdFromMessage: bootstrap.resolveTaskIdFromMessage }
      : {}),
  });

  await client.login(token);

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.warn('[discord] SIGTERM/shutdown — closing ws');
    try {
      await client.destroy();
    } catch (err) {
      console.error('[discord] destroy failed:', err);
    }
  };

  const onSigterm = (): void => {
    void shutdown().then(() => process.exit(0));
  };
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigterm);

  return shutdown;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`[discord] missing env var: ${name}`);
  }
  return v;
}

// CLI entry: invoked when this module is the node entrypoint. Production wiring
// of ChannelRouter (T4) and DiscordOut (T5) lives in src/server.ts (T2) — this
// path is for `node --import tsx src/discord/index.ts` smoke runs only.
const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('discord/index.ts') || arg.endsWith('discord/index.js');
})();

if (isEntryPoint) {
  const stubRouter: ChannelRouter = {
    resolve: () => null,
    list: () => [],
  };
  startDiscordBot({ router: stubRouter }).catch((err) => {
    console.error('[discord] startup failed:', err);
    process.exit(1);
  });
}
