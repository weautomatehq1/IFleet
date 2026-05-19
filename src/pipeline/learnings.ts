// Per-repo learnings store. Each repo carries a running list of "things the
// agent learned about this codebase" at `<repoRoot>/.omc/learnings.md`. The
// architect reads the recent tail at the start of a sprint and appends any
// `<learning>` blocks emitted by the worker after a plan is produced.

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const LEARNINGS_RELATIVE_PATH = '.omc/learnings.md';

export const PRIOR_LEARNINGS_HEADER = '## Prior learnings';

const DEFAULT_TAIL = 50;

const LEARNING_BLOCK = /<learning>([\s\S]*?)<\/learning>/g;

export interface Learning {
  stamp: string;
  taskId: string;
  text: string;
}

export async function readRecentLearnings(
  repoRoot: string,
  limit: number = DEFAULT_TAIL,
): Promise<string[]> {
  const path = join(repoRoot, LEARNINGS_RELATIVE_PATH);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const lines = content
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.slice(-limit);
}

export function parseLearningBlocks(output: string): string[] {
  const out: string[] = [];
  for (const match of output.matchAll(LEARNING_BLOCK)) {
    const text = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

export async function appendLearnings(
  repoRoot: string,
  taskId: string,
  learnings: string[],
  now: Date = new Date(),
): Promise<void> {
  if (learnings.length === 0) return;
  const path = join(repoRoot, LEARNINGS_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  const stamp = formatStamp(now);
  const block = learnings.map((text) => `- ${stamp} | ${taskId} | ${text}\n`).join('');
  await appendFile(path, block, 'utf8');
}

export function formatPriorLearningsSection(lines: string[]): string {
  if (lines.length === 0) return '';
  return [PRIOR_LEARNINGS_HEADER, '', ...lines].join('\n');
}

function formatStamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
