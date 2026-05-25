// PM2 cron entry-point for scheduled audit runs.
// Reads AUDIT_MODE ('autopilot' | 'morning-report') and AUDIT_REPOS (comma-separated).
//
// autopilot:      spawns `claude -p /audit-fix auto` inside each repo checkout
// morning-report: reads each repo's .audits/index.json and posts a findings
//                 summary to #ifleet (channel 1504120127791042631)

import { execFile } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.js';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import type { TextChannel } from 'discord.js';
import {
  resolveAuditIndexPath,
  readAuditIndex,
  openFindings,
} from '../src/discord/audit-runner.js';

const execFileAsync = promisify(execFile);

const IFLEET_CHANNEL_ID = '1504120127791042631';
const AUDIT_MODE = process.env['AUDIT_MODE'] ?? 'morning-report';
const AUDIT_REPOS = (process.env['AUDIT_REPOS'] ?? 'IFleet')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? '/usr/bin/claude';

// Repos are expected to be siblings of the IFleet checkout.
// IFleet itself resolves to IFLEET_REPO_ROOT (or cwd) to avoid duplication.
function resolveRepoPath(repo: string): string {
  const ifleetRoot = process.env['IFLEET_REPO_ROOT'] ?? process.cwd();
  if (repo === 'IFleet') return ifleetRoot;
  const base = process.env['AUDIT_BASE_DIR'] ?? resolve(ifleetRoot, '..');
  return resolve(base, repo);
}

async function runAutopilot(repos: string[]): Promise<void> {
  for (const repo of repos) {
    const cwd = resolveRepoPath(repo);
    console.log(`[audit-ritual] autopilot ${repo} → ${cwd}`);
    try {
      await execFileAsync(CLAUDE_BIN, ['-p', '/audit-fix auto'], { cwd });
      console.log(`[audit-ritual] autopilot done: ${repo}`);
    } catch (err) {
      console.error(
        `[audit-ritual] autopilot failed: ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function runMorningReport(repos: string[]): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) throw new Error('[audit-ritual] DISCORD_BOT_TOKEN not set');

  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`**Audit morning report — ${date}**`, ''];

  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo);
    const indexPath = resolveAuditIndexPath(repoPath);
    const index = readAuditIndex(indexPath);
    if (!index) {
      lines.push(`**${repo}** — no findings index (run /audit-scan first)`);
      continue;
    }
    const open = openFindings(index);
    const sev = index.by_severity;
    lines.push(
      `**${repo}** — ${open.length} open` +
        ` (CRITICAL: ${sev['CRITICAL'] ?? 0}` +
        `, IMPORTANT: ${sev['IMPORTANT'] ?? 0}` +
        `, COSMETIC: ${sev['COSMETIC'] ?? 0})`,
    );
  }

  const message = lines.join('\n');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', async () => {
        try {
          const channel = await client.channels.fetch(IFLEET_CHANNEL_ID);
          if (!channel || !('send' in channel)) {
            throw new Error(`channel ${IFLEET_CHANNEL_ID} is not a text channel`);
          }
          await (channel as TextChannel).send(message);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  } finally {
    client.destroy();
  }
  console.log('[audit-ritual] morning report posted');
}

async function main(): Promise<void> {
  console.log(`[audit-ritual] mode=${AUDIT_MODE} repos=${AUDIT_REPOS.join(',')}`);
  if (AUDIT_MODE === 'autopilot') {
    await runAutopilot(AUDIT_REPOS);
  } else {
    await runMorningReport(AUDIT_REPOS);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[audit-ritual] fatal:', err);
    process.exit(1);
  });
}
