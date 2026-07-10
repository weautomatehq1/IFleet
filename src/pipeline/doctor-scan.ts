// Testable core of the periodic doctor scan. The actual long-running PM2 entry
// lives in `scripts/doctor-scan.ts` and is a thin wrapper that constructs the
// dependencies (Claude CLI runner, Discord webhook poster, event-log reader)
// and drives the cycle on a timer. Keeping the logic here lets the tests run
// without touching the network or spawning child processes.

import type { Event } from '@wahq/orchestrator-core/observability/types';
import {
  buildRollupPrompt,
  collectLearnings,
  dedupeLearnings,
  formatRollupFallback,
  DISCORD_DAILY_BRIEF_LIMIT,
  type LearningEntry,
} from './rollup.js';

export const DEFAULT_SCAN_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_ROLLUP_HOUR_LOCAL = 6;
export const DEFAULT_SCAN_EVENT_WINDOW = 50;
export const SCAN_DISABLED_ENV = 'DOCTOR_SCAN_DISABLED';

export interface ClaudeRunner {
  /** Returns the model's text output. Never throws — empty string on failure. */
  run(prompt: string, model: string): Promise<string>;
}

export interface DiscordPoster {
  /** Post a single message. Never throws. */
  post(content: string): Promise<void>;
}

export interface EventReader {
  /** Return events in roughly chronological order; the most recent come last. */
  readRecent(limit: number): Event[];
}

export interface ScanCycleOpts {
  events: EventReader;
  claude: ClaudeRunner;
  discord: DiscordPoster;
  haikuModel?: string;
  eventWindow?: number;
}

export interface RollupCycleOpts {
  repoRoots: ReadonlyArray<string>;
  claude: ClaudeRunner;
  discord: DiscordPoster;
  haikuModel?: string;
  sinceTs?: string;
  maxChars?: number;
}

const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * One pass of the periodic Haiku scan. Posts a one-line summary to Discord
 * when at least one notable event was found. No-ops when DOCTOR_SCAN_DISABLED
 * is set or the recent-event window has no errors/failures worth reporting.
 */
export async function runScanCycle(opts: ScanCycleOpts): Promise<{ posted: boolean }> {
  if (isDisabled()) return { posted: false };
  const window = opts.eventWindow ?? DEFAULT_SCAN_EVENT_WINDOW;
  const recent = opts.events.readRecent(window);
  if (!hasNotableEvents(recent)) return { posted: false };

  const prompt = buildScanPrompt(recent);
  const model = opts.haikuModel ?? DEFAULT_HAIKU_MODEL;
  const summary = (await opts.claude.run(prompt, model)).trim();
  if (!summary) return { posted: false };

  await opts.discord.post(truncate(`🩺 **Doctor scan** — ${summary}`, 1900));
  return { posted: true };
}

/**
 * One pass of the morning rollup. Reads `.omc/learnings.md` across all
 * `repoRoots`, dedupes, asks Haiku for a summary, and posts. Falls back to a
 * deterministic markdown digest when Haiku returns empty.
 */
export async function runRollupCycle(opts: RollupCycleOpts): Promise<{ posted: boolean }> {
  if (isDisabled()) return { posted: false };
  const sinceTs = opts.sinceTs ?? formatLocalDayKey(addDays(new Date(), -1));
  const merged = dedupeLearnings(
    collectLearnings({ repoRoots: [...opts.repoRoots], sinceTs }),
  );
  if (merged.length === 0) {
    await opts.discord.post('☀️ **Morning brief** — no new learnings overnight.');
    return { posted: true };
  }

  const maxChars = opts.maxChars ?? DISCORD_DAILY_BRIEF_LIMIT;
  const model = opts.haikuModel ?? DEFAULT_HAIKU_MODEL;
  const summary = (await opts.claude.run(buildRollupPrompt(merged), model)).trim();
  const body = summary ? truncate(summary, maxChars) : formatRollupFallback(merged, maxChars);
  await opts.discord.post(summary ? `☀️ **Morning brief**\n${body}` : body);
  return { posted: true };
}

/**
 * Returns true once per local day after the configured rollup hour. Callers
 * pass in `lastRunISO` from durable state so a restart inside the same day
 * does not double-post.
 */
export function shouldRunDailyRollup(
  now: Date,
  lastRunISO: string | undefined,
  rollupHourLocal: number = DEFAULT_ROLLUP_HOUR_LOCAL,
): boolean {
  if (now.getHours() < rollupHourLocal) return false;
  if (!lastRunISO) return true;
  const lastKey = formatLocalDayKey(new Date(lastRunISO));
  const nowKey = formatLocalDayKey(now);
  return lastKey !== nowKey;
}

export function buildScanPrompt(events: ReadonlyArray<Event>): string {
  const lines = events
    .slice(-DEFAULT_SCAN_EVENT_WINDOW)
    .map((e) => `[${new Date(e.ts).toISOString()}] ${e.kind} task=${e.taskId ?? '-'} worker=${e.workerId ?? '-'}`);
  return [
    'You are IFleet\'s on-call doctor. Look at these recent orchestrator events',
    'and decide: is there a pattern of failure worth escalating to a human?',
    'If yes, reply with ONE sentence describing the pattern + which task ids',
    'are involved. If everything looks fine, reply with the single word: OK.',
    '',
    'Events (oldest first):',
    ...lines,
  ].join('\n');
}

export function hasNotableEvents(events: ReadonlyArray<Event>): boolean {
  return events.some(
    (e) =>
      e.kind === 'task.failed' ||
      e.kind === 'error' ||
      e.kind === 'worker.rateLimit' ||
      e.kind === 'rateLimit',
  );
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isDisabled(): boolean {
  const v = process.env[SCAN_DISABLED_ENV];
  return v === '1' || v === 'true';
}

function formatLocalDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Used by LearningEntry type tests indirectly — keep the import alive when
// downstream consumers tree-shake this file.
export type { LearningEntry };
