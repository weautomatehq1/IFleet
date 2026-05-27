/**
 * Daily standup generator.
 *
 * Posts a 9am summary to #ifleet (channel 1504120127791042631).
 * Data sources (in priority order):
 *   1. events table (FileEventLog, .omc/sprints/) — tasks completed yesterday
 *   2. attempts table (AttemptRecord[] in event payloads) — success/failure counts
 *   3. verifier_runs — empty until T2 ships; degrade gracefully
 *   4. PM2 process state — uptime / restarts via `pm2 jlist`
 *   5. goal_proposals — does not exist yet, stub commented for M5
 *
 * HARD RULE: system prompt enforces "Facts only. No flattery."
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { parseEvents } from '../../observability/event-log.js';
import { readFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);

const IFLEET_CHANNEL_ID = '1504120127791042631';
// Legacy sprint events path; gracefully skipped if missing.
const SPRINTS_DIR = resolve(process.cwd(), '.omc/sprints');

// ---- Data collection --------------------------------------------------------

interface StandupData {
  date: string;
  tasksCompleted: number;
  tasksFailed: number;
  verifierPassRate: string;
  costUsd: string;
  pm2Restarts: number;
  pm2Uptime: string;
  blockers: string[];
}

async function collectData(): Promise<StandupData> {
  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setHours(23, 59, 59, 999);

  const fromTs = yesterdayStart.getTime();
  const toTs = yesterdayEnd.getTime();

  let tasksCompleted = 0;
  let tasksFailed = 0;
  let totalCostUsd = 0;
  let verifierPassed = 0;
  let verifierTotal = 0;

  if (existsSync(SPRINTS_DIR)) {
    const sprintDirs = readdirSync(SPRINTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(SPRINTS_DIR, d.name, 'events.jsonl'));

    for (const file of sprintDirs) {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const events = parseEvents(raw).filter((e) => e.ts >= fromTs && e.ts <= toTs);

      for (const e of events) {
        if (e.kind === 'task.done') tasksCompleted++;
        if (e.kind === 'task.failed') tasksFailed++;
        if (e.kind === 'verifier.passed') {
          verifierPassed++;
          verifierTotal++;
          const cost = e.payload?.['costUsd'];
          if (typeof cost === 'number') totalCostUsd += cost;
        }
        if (e.kind === 'verifier.failed' || e.kind === 'verifier.timeout') {
          verifierTotal++;
        }
        const attemptCost = e.payload?.['totalCostUsd'];
        if (typeof attemptCost === 'number' && e.kind !== 'verifier.passed') {
          totalCostUsd += attemptCost;
        }
      }
    }
  }

  const verifierPassRate =
    verifierTotal > 0 ? `${Math.round((verifierPassed / verifierTotal) * 100)}%` : 'n/a (verifier not yet wired)';

  const costDisplay = totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : 'n/a';

  // PM2 state
  let pm2Restarts = 0;
  let pm2Uptime = 'unknown';
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist']);
    const procs: Array<{ name: string; pm2_env?: { restart_time?: number; pm_uptime?: number } }> = JSON.parse(stdout);
    const ifleet = procs.find((p) => p.name === 'ifleet');
    if (ifleet?.pm2_env) {
      pm2Restarts = ifleet.pm2_env.restart_time ?? 0;
      const uptimeMs = ifleet.pm2_env.pm_uptime ? Date.now() - ifleet.pm2_env.pm_uptime : 0;
      pm2Uptime = formatDuration(uptimeMs);
    }
  } catch {
    // PM2 not available in dev — ignore
  }

  return {
    date: now.toISOString().slice(0, 10),
    tasksCompleted,
    tasksFailed,
    verifierPassRate,
    costUsd: costDisplay,
    pm2Restarts,
    pm2Uptime,
    blockers: [],
  };
}

// ---- Format -----------------------------------------------------------------

export function formatStandup(data: StandupData): string {
  const lines: string[] = [];

  lines.push(`**IFleet standup — ${data.date}**`);
  lines.push('');

  lines.push('**Yesterday:**');
  if (data.tasksCompleted === 0 && data.tasksFailed === 0) {
    lines.push('  Slow day — 0 tasks completed, 0 failed. M1 verifier work continues today.');
  } else {
    if (data.tasksCompleted > 0) lines.push(`  Tasks completed: ${data.tasksCompleted}`);
    if (data.tasksFailed > 0) lines.push(`  Tasks failed: ${data.tasksFailed}`);
  }

  lines.push('');
  lines.push('**Metrics (last 24h):**');
  lines.push(`  Verifier pass rate: ${data.verifierPassRate}`);
  lines.push(`  Cost: ${data.costUsd}`);
  lines.push(`  ifleet uptime: ${data.pm2Uptime}${data.pm2Restarts > 0 ? ` (${data.pm2Restarts} restart${data.pm2Restarts !== 1 ? 's' : ''})` : ''}`);

  if (data.blockers.length > 0) {
    lines.push('');
    lines.push('**Blockers:**');
    for (const b of data.blockers) lines.push(`  ${b}`);
  }

  // TODO M5+: goal_proposals queue — "N proposals queued in #ifleet-proposals"

  return lines.join('\n');
}

// ---- Post -------------------------------------------------------------------

export async function postStandup(): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) {
    throw new Error('[standup] DISCORD_BOT_TOKEN not set');
  }

  const data = await collectData();
  const message = formatStandup(data);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', async () => {
        try {
          const channel = await client.channels.fetch(IFLEET_CHANNEL_ID);
          if (!channel || !('send' in channel)) {
            throw new Error(`[standup] channel ${IFLEET_CHANNEL_ID} is not a text channel`);
          }
          // Discord limit is 2000 chars — split if needed
          if (message.length <= 2000) {
            await (channel as import('discord.js').TextChannel).send(message);
          } else {
            const chunks = splitMessage(message, 1900);
            for (const chunk of chunks) {
              await (channel as import('discord.js').TextChannel).send(chunk);
            }
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  } finally {
    client.destroy();
  }

  console.warn(`[standup] posted for ${data.date}`);
}

function splitMessage(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current.length === 0 ? line : current + '\n' + line;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current.length > 0) chunks.push(current);
      current = line;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// ---- CLI entry --------------------------------------------------------------

const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('standup.ts') || arg.endsWith('standup.js');
})();

if (isEntryPoint) {
  postStandup().catch((err) => {
    console.error('[standup] failed:', err);
    process.exit(1);
  });
}
