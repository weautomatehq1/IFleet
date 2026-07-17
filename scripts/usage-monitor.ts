#!/usr/bin/env node
// Usage monitor — checks ccusage burn rate and alerts Discord when projected
// weekly consumption reaches CCUSAGE_ALERT_THRESHOLD (default 0.8 = 80%) of
// the configured weekly cap.
//
// Runs standalone; not imported by the IFleet daemon. Opt-in via:
//   pm2 start scripts/usage-monitor.pm2.json
//
// Config env vars (all optional, sane defaults shown):
//   DISCORD_BOT_TOKEN          — Discord bot token for posting alerts
//   CCUSAGE_DISCORD_CHANNEL    — channel ID for alerts (default: ifleet #ifleet)
//   CCUSAGE_BLOCK_CAP          — max entries per 5-hour block (default: 1000)
//   CCUSAGE_WEEKLY_CAP         — max entries per 7-day window (default: 20000)
//   CCUSAGE_ALERT_THRESHOLD    — fractional threshold to alert at (default: 0.8)
//   CCUSAGE_USAGE_DIR          — where to write .ifleet/usage/<date>.json rows

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isMainModule } from './lib/is-main-module.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---- config ----------------------------------------------------------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const DISCORD_CHANNEL_ID =
  process.env.CCUSAGE_DISCORD_CHANNEL ?? '1504120127791042631';
// Max entries per 5-hour block (Claude API billing window). Configurable via
// CCUSAGE_BLOCK_CAP; legacy IFLEET_BLOCK_CAP kept as fallback so VPS configs
// that pre-date the rename keep working. Default 1000.
const _rawBlockCap = parseInt(
  process.env.CCUSAGE_BLOCK_CAP ?? process.env.IFLEET_BLOCK_CAP ?? '1000',
  10,
);
const BLOCK_CAP = Number.isFinite(_rawBlockCap) && _rawBlockCap > 0
  ? _rawBlockCap
  : (console.warn('[usage-monitor] CCUSAGE_BLOCK_CAP is not a positive integer — using default 1000'), 1000);
// Max entries per 7-day window (Claude API billing cycle). Same dual-name
// pattern as BLOCK_CAP. Default 20000.
const _rawWeeklyCap = parseInt(
  process.env.CCUSAGE_WEEKLY_CAP ?? process.env.IFLEET_WEEKLY_CAP ?? '20000',
  10,
);
const WEEKLY_CAP = Number.isFinite(_rawWeeklyCap) && _rawWeeklyCap > 0
  ? _rawWeeklyCap
  : (console.warn('[usage-monitor] CCUSAGE_WEEKLY_CAP is not a positive integer — using default 20000'), 20000);
const _rawAlertThreshold = parseFloat(process.env.CCUSAGE_ALERT_THRESHOLD ?? '0.8');
const ALERT_THRESHOLD = Number.isFinite(_rawAlertThreshold) && _rawAlertThreshold > 0 && _rawAlertThreshold <= 1
  ? _rawAlertThreshold
  : (console.warn('[usage-monitor] CCUSAGE_ALERT_THRESHOLD must be a number in (0,1] — using default 0.8'), 0.8);

// Where .ifleet/usage/<date>.json rows are written. Defaults to the repo root
// relative to this script (two directories up from scripts/).
const USAGE_DIR =
  process.env.CCUSAGE_USAGE_DIR ??
  join(new URL('.', import.meta.url).pathname, '..', '.ifleet', 'usage');

// ---- types -----------------------------------------------------------------

export interface CcusageBlock {
  id: string;
  startTime: string;
  endTime: string;
  actualEndTime?: string;
  isActive: boolean;
  isGap: boolean;
  entries: number;
  costUSD: number;
  totalTokens: number;
  burnRate: number | null;
  projection: number | null;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  models: string[];
}

export interface CcusageOutput {
  blocks: CcusageBlock[];
}

export interface UsageSnapshot {
  date: string;
  capturedAt: string;
  activeBlock: {
    id: string;
    entries: number;
    projectedEntries: number | null;
    burnRate: number | null;
    blockCapPct: number;
  } | null;
  last7DaysEntries: number;
  last7DaysCostUSD: number;
  weeklyCapPct: number;
  alertFired: boolean;
  alertReason: string;
}

// ---- ccusage ---------------------------------------------------------------

export async function fetchCcusageBlocks(): Promise<CcusageOutput> {
  // Prefer the locally-installed binary (devDependency) so we don't pay the
  // network round-trip and don't depend on whichever npm version `npx`
  // resolves at runtime. Fall back to `npx --yes ccusage` for environments
  // where ccusage was not installed locally (e.g. fresh clones running
  // this script before pnpm install). Supply-chain risk is the same as the
  // package manager — pinning to the local install at least pins the
  // version to the lockfile.
  const localBin = './node_modules/.bin/ccusage';
  let cmd: string;
  let args: string[];
  if (existsSync(localBin)) {
    cmd = localBin;
    args = ['blocks', '--json'];
  } else {
    cmd = 'npx';
    args = ['--yes', 'ccusage', 'blocks', '--json'];
  }
  const { stdout } = await execFileAsync(cmd, args, { timeout: 30_000 });
  return JSON.parse(stdout) as CcusageOutput;
}

// ---- analysis --------------------------------------------------------------

export interface BurnAnalysis {
  activeBlock: CcusageBlock | null;
  last7DaysBlocks: CcusageBlock[];
  last7DaysEntries: number;
  last7DaysCostUSD: number;
  weeklyCapPct: number;
  activeBlockCapPct: number;
  alertFired: boolean;
  alertReason: string;
}

export function analyzeBlocks(
  output: CcusageOutput,
  opts: {
    blockCap?: number;
    weeklyCap?: number;
    alertThreshold?: number;
    now?: Date;
  } = {},
): BurnAnalysis {
  const blockCap = opts.blockCap ?? BLOCK_CAP;
  const weeklyCap = opts.weeklyCap ?? WEEKLY_CAP;
  const alertThreshold = opts.alertThreshold ?? ALERT_THRESHOLD;
  const now = opts.now ?? new Date();

  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const activeBlock = output.blocks.find((b) => b.isActive) ?? null;
  const last7DaysBlocks = output.blocks.filter(
    (b) => !b.isGap && new Date(b.startTime) >= cutoff,
  );

  const last7DaysEntries = last7DaysBlocks.reduce((sum, b) => sum + b.entries, 0);
  const last7DaysCostUSD = last7DaysBlocks.reduce((sum, b) => sum + b.costUSD, 0);

  const weeklyCapPct = last7DaysEntries / weeklyCap;

  // For the active block, prefer projection if available; fall back to entries.
  const activeEntries = activeBlock
    ? (activeBlock.projection ?? activeBlock.entries)
    : 0;
  const activeBlockCapPct = activeBlock ? activeEntries / blockCap : 0;

  const reasons: string[] = [];
  if (weeklyCapPct >= alertThreshold) {
    reasons.push(
      `weekly: ${last7DaysEntries.toLocaleString()} / ${weeklyCap.toLocaleString()} entries ` +
        `(${Math.round(weeklyCapPct * 100)}%)`,
    );
  }
  if (activeBlock && activeBlockCapPct >= alertThreshold) {
    reasons.push(
      `active block: ${Math.round(activeEntries).toLocaleString()} / ${blockCap.toLocaleString()} ` +
        `projected entries (${Math.round(activeBlockCapPct * 100)}%)`,
    );
  }

  return {
    activeBlock,
    last7DaysBlocks,
    last7DaysEntries,
    last7DaysCostUSD,
    weeklyCapPct,
    activeBlockCapPct,
    alertFired: reasons.length > 0,
    alertReason: reasons.join('; '),
  };
}

// ---- Discord post ----------------------------------------------------------

export async function postToDiscord(
  channelId: string,
  botToken: string,
  message: string,
): Promise<void> {
  if (!botToken) {
    console.warn('[usage-monitor] DISCORD_BOT_TOKEN not set — skipping Discord post');
    return;
  }
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord post failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export function buildAlertMessage(analysis: BurnAnalysis): string {
  const lines: string[] = [
    '**[IFleet] Claude Max burn-rate alert**',
    '',
    `Last 7 days: **${analysis.last7DaysEntries.toLocaleString()}** entries ` +
      `(${Math.round(analysis.weeklyCapPct * 100)}% of ${WEEKLY_CAP.toLocaleString()} weekly cap)`,
  ];
  if (analysis.activeBlock) {
    const projected = analysis.activeBlock.projection ?? analysis.activeBlock.entries;
    lines.push(
      `Current block: **${Math.round(projected).toLocaleString()}** projected entries ` +
        `(${Math.round(analysis.activeBlockCapPct * 100)}% of ${BLOCK_CAP.toLocaleString()} block cap)`,
    );
    if (analysis.activeBlock.burnRate !== null) {
      lines.push(`Burn rate: ${analysis.activeBlock.burnRate.toFixed(1)} entries/min`);
    }
  }
  lines.push('', `Reason: ${analysis.alertReason}`);
  return lines.join('\n');
}

// ---- persistence -----------------------------------------------------------

export async function writeUsageRow(
  analysis: BurnAnalysis,
  usageDir: string,
  alertFired: boolean,
): Promise<void> {
  await mkdir(usageDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const path = join(usageDir, `${today}.json`);

  // Merge with any existing rows from today (multiple runs per day).
  let existing: UsageSnapshot[] = [];
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    existing = Array.isArray(parsed) ? (parsed as UsageSnapshot[]) : [];
  } catch {
    // first run of the day
  }

  const snapshot: UsageSnapshot = {
    date: today,
    capturedAt: new Date().toISOString(),
    activeBlock: analysis.activeBlock
      ? {
          id: analysis.activeBlock.id,
          entries: analysis.activeBlock.entries,
          projectedEntries: analysis.activeBlock.projection,
          burnRate: analysis.activeBlock.burnRate,
          blockCapPct: analysis.activeBlockCapPct,
        }
      : null,
    last7DaysEntries: analysis.last7DaysEntries,
    last7DaysCostUSD: analysis.last7DaysCostUSD,
    weeklyCapPct: analysis.weeklyCapPct,
    alertFired,
    alertReason: analysis.alertReason,
  };

  existing.push(snapshot);
  await writeFile(path, JSON.stringify(existing, null, 2), 'utf8');
  console.log(`[usage-monitor] wrote row to ${path}`);
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[usage-monitor] fetching ccusage blocks...');
  const output = await fetchCcusageBlocks();
  const analysis = analyzeBlocks(output);

  console.log(
    `[usage-monitor] last-7d entries: ${analysis.last7DaysEntries} ` +
      `(${Math.round(analysis.weeklyCapPct * 100)}% of weekly cap)`,
  );
  if (analysis.activeBlock) {
    console.log(
      `[usage-monitor] active block entries: ${analysis.activeBlock.entries} ` +
        `(projected: ${analysis.activeBlock.projection ?? 'n/a'})`,
    );
  }

  if (analysis.alertFired) {
    console.log(`[usage-monitor] alert threshold reached: ${analysis.alertReason}`);
    const message = buildAlertMessage(analysis);
    await postToDiscord(DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN, message);
  } else {
    console.log('[usage-monitor] below threshold — no alert');
  }

  await writeUsageRow(analysis, USAGE_DIR, analysis.alertFired);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[usage-monitor] fatal:', err);
    process.exit(1);
  });
}
