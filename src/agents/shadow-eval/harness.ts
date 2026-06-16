// M6 — shadow-eval harness.
//
// Reads an eval-set JSONL, replays each row through the architect +
// verifier seams, returns a summary. Bounded concurrency defaults to 1
// because the eval-set is small (≤50 rows per spec) and deterministic
// ordering makes failing rows trivial to bisect.

import { readFile } from 'node:fs/promises';

import { replayRow, type ReplayDeps } from './replay.js';
import type { EvalResult, EvalRow, ShadowEvalSummary } from './types.js';

export interface HarnessDeps {
  evalSetPath: string;
  /** Override the file reader — tests inject in-memory rows. */
  readEvalSet?: (path: string) => Promise<EvalRow[]>;
  replayDeps: ReplayDeps;
  /** Bounded concurrency. Default 1 (deterministic, eval-set is small). */
  concurrency?: number;
  /** Override the clock — tests inject a fixed value. */
  now?: () => number;
}

export async function runShadowEval(deps: HarnessDeps): Promise<ShadowEvalSummary> {
  const now = deps.now ?? ((): number => Date.now());
  const read = deps.readEvalSet ?? defaultReadEvalSet;
  const concurrency = Math.max(1, deps.concurrency ?? 1);

  const runStartedAt = new Date(now()).toISOString();
  const rows = await read(deps.evalSetPath);

  const results: EvalResult[] = new Array(rows.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, rows.length);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= rows.length) return;
          const row = rows[i]!;
          results[i] = await replayRow(row, deps.replayDeps);
        }
      })(),
    );
  }
  await Promise.all(workers);

  const passed = results.filter((r) => r.verdict === 'PASS').length;
  const runFinishedAt = new Date(now()).toISOString();
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    results,
    runStartedAt,
    runFinishedAt,
  };
}

/**
 * Default JSONL reader. Empty file (zero non-blank lines) returns `[]`
 * — the harness must not throw on an empty eval-set, since the
 * eval-set-growth lane lands rows incrementally.
 */
export async function defaultReadEvalSet(path: string): Promise<EvalRow[]> {
  const raw = await readFile(path, 'utf8');
  const rows: EvalRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    rows.push(JSON.parse(trimmed) as EvalRow);
  }
  return rows;
}
