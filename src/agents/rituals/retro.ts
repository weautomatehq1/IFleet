/**
 * Weekly retro generator.
 *
 * Posts a Sunday 8pm UTC summary to #ifleet summarising the past 7 days.
 * Data sources:
 *   1. pr_decisions (KG Postgres) — merged/rejected/abandoned verdicts
 *   2. goal_proposals (KG Postgres) — proposal pipeline counts
 *   3. events table (FileEventLog, .omc/sprints/) — 7-day cost aggregation
 *   4. PM2 process state — uptime / restarts via `pm2 jlist`
 *
 * Fail-open on every data source — an empty retro still gets posted.
 * TODO: Move to #ifleet-ops when channel is created.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import type { Pool } from 'pg';
import { parseEvents } from '../../observability/event-log.js';
import { getKgPool, KgPostgresUnavailableError } from '../indexer/pg-client.js';

const execFileAsync = promisify(execFile);

// TODO: Move to #ifleet-ops when channel is created.
const IFLEET_CHANNEL_ID = '1504120127791042631';
const SPRINTS_DIR = resolve(process.cwd(), '.omc/sprints');

// ---- Public interface --------------------------------------------------------

export interface RetroData {
  weekStart: string;
  weekEnd: string;
  prVerdicts: { merged: number; rejected: number; abandoned: number };
  proposals: { proposed: number; approved: number; rejected: number; pending: number };
  costUsd: string;
  pm2Uptime: string;
  pm2Restarts: number;
}

// ---- Local KG query helpers --------------------------------------------------

async function queryPrVerdicts(pool?: Pool): Promise<RetroData['prVerdicts']> {
  try {
    const p = pool ?? getKgPool();
    const result = await p.query<{ verdict: string; count: string }>(
      `SELECT verdict, COUNT(*)::text AS count
         FROM pr_decisions
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY verdict`,
    );
    const counts = { merged: 0, rejected: 0, abandoned: 0 };
    for (const row of result.rows) {
      const n = Number.parseInt(row.count, 10);
      if (!Number.isFinite(n)) continue;
      if (row.verdict === 'merged') counts.merged = n;
      else if (row.verdict === 'rejected') counts.rejected = n;
      else if (row.verdict === 'abandoned') counts.abandoned = n;
    }
    return counts;
  } catch (err) {
    if (err instanceof KgPostgresUnavailableError) {
      console.warn(`[retro] queryPrVerdicts: ${err.message}`);
    } else {
      console.warn(`[retro] queryPrVerdicts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { merged: 0, rejected: 0, abandoned: 0 };
  }
}

async function queryProposalCounts(pool?: Pool): Promise<RetroData['proposals']> {
  try {
    const p = pool ?? getKgPool();
    const result = await p.query<{ decision: string | null; count: string }>(
      `SELECT decision, COUNT(*)::text AS count
         FROM goal_proposals
        WHERE proposed_at > NOW() - INTERVAL '7 days'
        GROUP BY decision`,
    );
    const counts = { proposed: 0, approved: 0, rejected: 0, pending: 0 };
    for (const row of result.rows) {
      const n = Number.parseInt(row.count, 10);
      if (!Number.isFinite(n)) continue;
      counts.proposed += n;
      if (row.decision === null) counts.pending += n;
      else if (row.decision === 'approved') counts.approved += n;
      else if (row.decision === 'rejected') counts.rejected += n;
    }
    return counts;
  } catch (err) {
    if (err instanceof KgPostgresUnavailableError) {
      console.warn(`[retro] queryProposalCounts: ${err.message}`);
    } else {
      console.warn(`[retro] queryProposalCounts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { proposed: 0, approved: 0, rejected: 0, pending: 0 };
  }
}

// ---- Data collection ---------------------------------------------------------

export async function collectRetroData(): Promise<RetroData> {
  const now = new Date();

  // weekEnd = today normalised to midnight; weekStart = 6 days prior (Monday when cron fires Sunday)
  const weekEndDate = new Date(now);
  weekEndDate.setHours(0, 0, 0, 0);
  const weekStartDate = new Date(weekEndDate);
  weekStartDate.setDate(weekEndDate.getDate() - 6);
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);

  // 7-day cost roll-up (mirror standup.ts pattern, widen window to 7 days)
  const fromTs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const toTs = now.getTime();
  let totalCostUsd = 0;

  if (existsSync(SPRINTS_DIR)) {
    const sprintDirs = readdirSync(SPRINTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(SPRINTS_DIR, d.name, 'events.jsonl'));
    for (const file of sprintDirs) {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const events = parseEvents(raw).filter((e) => e.ts >= fromTs && e.ts <= toTs);
      for (const e of events) {
        if (e.kind === 'verifier.passed') {
          const cost = e.payload?.['costUsd'];
          if (typeof cost === 'number') totalCostUsd += cost;
        }
        const attemptCost = e.payload?.['totalCostUsd'];
        if (typeof attemptCost === 'number' && e.kind !== 'verifier.passed') {
          totalCostUsd += attemptCost;
        }
      }
    }
  }
  const costUsd = totalCostUsd > 0 ? `$${totalCostUsd.toFixed(2)}` : 'n/a';

  // PM2 state
  let pm2Restarts = 0;
  let pm2Uptime = 'unknown';
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist']);
    const procs: Array<{ name: string; pm2_env?: { restart_time?: number; pm_uptime?: number } }> =
      JSON.parse(stdout);
    const ifleet = procs.find((p) => p.name === 'ifleet');
    if (ifleet?.pm2_env) {
      pm2Restarts = ifleet.pm2_env.restart_time ?? 0;
      const uptimeMs = ifleet.pm2_env.pm_uptime ? Date.now() - ifleet.pm2_env.pm_uptime : 0;
      pm2Uptime = formatDuration(uptimeMs);
    }
  } catch {
    // PM2 not available in dev — ignore
  }

  // KG queries — both fail-open
  const [prVerdicts, proposals] = await Promise.all([queryPrVerdicts(), queryProposalCounts()]);

  return { weekStart, weekEnd, prVerdicts, proposals, costUsd, pm2Uptime, pm2Restarts };
}

// ---- Format ------------------------------------------------------------------

export function formatRetro(data: RetroData): string {
  const lines: string[] = [];

  lines.push(`**IFleet weekly retro — ${data.weekStart} to ${data.weekEnd}**`);
  lines.push('');

  lines.push('**Week in review (PR decisions):**');
  lines.push(
    `  Merged: ${data.prVerdicts.merged} · Rejected: ${data.prVerdicts.rejected} · Abandoned: ${data.prVerdicts.abandoned}`,
  );

  const { proposed, approved, rejected, pending } = data.proposals;
  if (proposed > 0 || approved > 0 || rejected > 0 || pending > 0) {
    lines.push('');
    lines.push('**Proposer queue:**');
    lines.push(`  Proposed: ${proposed} · Approved: ${approved} · Rejected: ${rejected} · Pending: ${pending}`);
  }

  lines.push('');
  lines.push(`**Cost (7d):** ${data.costUsd}`);

  lines.push('');
  lines.push('**System health:**');
  lines.push(
    `  ifleet uptime: ${data.pm2Uptime}${data.pm2Restarts > 0 ? ` (${data.pm2Restarts} restart${data.pm2Restarts !== 1 ? 's' : ''})` : ''}`,
  );

  return lines.join('\n');
}

// ---- Post --------------------------------------------------------------------

export async function postRetro(): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) {
    throw new Error('[retro] DISCORD_BOT_TOKEN not set');
  }

  const data = await collectRetroData();
  const message = formatRetro(data);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', async () => {
        try {
          const channel = await client.channels.fetch(IFLEET_CHANNEL_ID);
          if (!channel || !('send' in channel)) {
            throw new Error(`[retro] channel ${IFLEET_CHANNEL_ID} is not a text channel`);
          }
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
  } catch (err) {
    // Fail-open: log Discord errors and continue
    console.warn(`[retro] Discord post failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.destroy();
  }

  console.warn(`[retro] posted for week ${data.weekStart} to ${data.weekEnd}`);
}

// ---- Helpers -----------------------------------------------------------------

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

// ---- CLI entry ---------------------------------------------------------------

const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('retro.ts') || arg.endsWith('retro.js');
})();

if (isEntryPoint) {
  console.warn('[ifleet-retro] starting…');
  postRetro().catch((err) => {
    console.error('[retro] failed:', err);
    process.exit(1);
  });
}
