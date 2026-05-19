// Daily learnings rollup. Reads `.omc/learnings.md` from every managed repo,
// dedupes entries, optionally hands the deduped list to Haiku for a short
// natural-language summary, and returns a Discord-safe single-message string
// (≤1500 chars by default — Discord's hard cap is 2000).
//
// T1 writes per-repo learnings in this format (one entry per line):
//   - YYYY-MM-DD HH:MM | <task-id> | <text>
// We do not import from T1's branch — only the file shape is shared.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface LearningEntry {
  ts: string;
  taskId: string;
  text: string;
  repo: string;
}

export interface CollectLearningsOpts {
  /** Absolute paths to repo roots. Each is checked for `.omc/learnings.md`. */
  repoRoots: ReadonlyArray<string>;
  /** Only include entries with `ts >= sinceTs` (string compare; ISO-like). */
  sinceTs?: string;
}

const LINE_RE = /^-\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;
export const DISCORD_DAILY_BRIEF_LIMIT = 1500;

export function parseLearningsFile(content: string, repo: string): LearningEntry[] {
  if (!content) return [];
  const out: LearningEntry[] = [];
  for (const raw of content.split('\n')) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    out.push({ ts: m[1]!.trim(), taskId: m[2]!.trim(), text: m[3]!.trim(), repo });
  }
  return out;
}

/**
 * Walk every repoRoot, read `.omc/learnings.md` if present, parse, and return
 * the merged list sorted by timestamp descending (newest first).
 */
export function collectLearnings(opts: CollectLearningsOpts): LearningEntry[] {
  const all: LearningEntry[] = [];
  for (const root of opts.repoRoots) {
    const file = join(root, '.omc', 'learnings.md');
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    const repo = basename(root);
    for (const entry of parseLearningsFile(content, repo)) {
      if (opts.sinceTs && entry.ts < opts.sinceTs) continue;
      all.push(entry);
    }
  }
  all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return all;
}

/**
 * Drop duplicate entries — same `text` across different repos counts once.
 * Preserves the newest occurrence (the list is assumed pre-sorted desc) and
 * annotates the surviving entry with the set of repos that saw it.
 */
export function dedupeLearnings(entries: ReadonlyArray<LearningEntry>): LearningEntry[] {
  const seen = new Map<string, LearningEntry>();
  for (const e of entries) {
    const key = e.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, e);
  }
  return [...seen.values()];
}

/**
 * Render a fallback markdown summary when Haiku is unavailable or disabled.
 * Always fits inside `maxChars` (truncates with a `…and N more` tail).
 */
export function formatRollupFallback(
  entries: ReadonlyArray<LearningEntry>,
  maxChars: number = DISCORD_DAILY_BRIEF_LIMIT,
): string {
  if (entries.length === 0) return '☀️ **Morning brief** — no new learnings overnight.';
  const header = `☀️ **Morning brief** — ${entries.length} learning${entries.length === 1 ? '' : 's'} overnight`;
  const lines: string[] = [header];
  let used = header.length;
  let included = 0;
  for (const e of entries) {
    const line = `• [${e.repo}] ${e.text}`;
    if (used + line.length + 1 > maxChars - 32) break;
    lines.push(line);
    used += line.length + 1;
    included++;
  }
  const remaining = entries.length - included;
  if (remaining > 0) lines.push(`…and ${remaining} more`);
  return lines.join('\n');
}

/**
 * Build the prompt handed to Haiku. Kept in this module so the test snapshots
 * one canonical version.
 */
export function buildRollupPrompt(entries: ReadonlyArray<LearningEntry>): string {
  const body = entries
    .slice(0, 50)
    .map((e) => `- [${e.repo}] ${e.ts} ${e.taskId}: ${e.text}`)
    .join('\n');
  return [
    'You are IFleet\'s morning reporter. Summarise these learnings from the last 24h',
    'into ONE Discord message under 1400 characters. Group related items.',
    'Lead with the most actionable thing. No markdown headers. No bullet lists',
    'longer than 6 items. Plain prose where possible.',
    '',
    'Learnings:',
    body,
  ].join('\n');
}
