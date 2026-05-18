// One-shot script: registers the IFleet slash commands with Discord for the
// configured guild. Run via `pnpm deploy:commands` whenever the slash command
// schema changes. Idempotent.
//
// Env required:
//   DISCORD_BOT_TOKEN   — bot token
//   DISCORD_CLIENT_ID   — application id
//   DISCORD_GUILD_ID    — guild to register against
//
// Pass --dry to print the JSON payload without hitting the Discord API
// (useful for CI smoke tests so we don't burn the API quota).

import { REST, Routes } from 'discord.js';
import { buildSlashCommands } from '../src/discord/slash-commands.js';

interface DeployOptions {
  dryRun: boolean;
}

export async function deployCommands(opts: DeployOptions): Promise<void> {
  const commands = buildSlashCommands().map((c) => c.toJSON());

  if (opts.dryRun) {
    console.log(JSON.stringify(commands, null, 2));
    console.log(`[deploy-commands] dry-run: ${commands.length} command(s) prepared`);
    return;
  }

  const token = requireEnv('DISCORD_BOT_TOKEN');
  const clientId = requireEnv('DISCORD_CLIENT_ID');
  const guildId = requireEnv('DISCORD_GUILD_ID');

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log(`[deploy-commands] registered ${commands.length} command(s) on guild ${guildId}`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[deploy-commands] missing env var: ${name}`);
  return v;
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('deploy-commands.ts') || arg.endsWith('deploy-commands.js');
})();

if (isMain) {
  const dryRun = process.argv.includes('--dry');
  deployCommands({ dryRun }).catch((err) => {
    console.error('[deploy-commands] failed:', err);
    process.exit(1);
  });
}
