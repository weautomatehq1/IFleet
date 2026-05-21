#!/usr/bin/env node
/**
 * A/B eval replay harness — runs the eval set against two pipeline versions
 * (baseline and current) and writes a structured diff to disk.
 *
 * Usage:
 *   pnpm tsx scripts/eval-replay-ab.ts \
 *     --baseline <git-ref> [--current <git-ref>] [--limit N] [--dry-run]
 *
 * Design:
 *   - "baseline" and "current" are git refs. Both are checked out into scratch
 *     worktrees rooted under $TMPDIR (or `--worktree-root`). The current ref
 *     defaults to `HEAD`.
 *   - In each worktree we shell out to `scripts/eval/run-eval-replay.ts` (the
 *     existing per-version runner) with `--limit N`. That script writes its
 *     summary to `.ifleet/eval/replay-results.json` inside the worktree; we
 *     read it back, normalize, and diff.
 *   - The diff is written to `.ifleet/eval/replay-results.json` at the repo
 *     root (the AB summary; overwrites any prior content). Override with
 *     `--output`.
 *   - `--dry-run` skips actual pipeline invocation and reports planned work
 *     only. No worktrees are created.
 *   - Worktrees are NOT removed (T1 owns cleanup per the split plan).
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---- Public types (also imported by unit tests) ----

export interface AbCliArgs {
  baseline: string;
  current: string;
  limit: number | null;
  dryRun: boolean;
  outputPath: string;
  worktreeRoot: string;
  runnerScript: string;
}

export interface RowOutcome {
  evalId: string;
  verifierPassed: boolean;
  costMinutes: number;
  prUrl: string | null;
}

export interface RowDiff {
  evalId: string;
  current: RowOutcome | null;
  baseline: RowOutcome | null;
  diff: {
    costMinutesDelta: number | null;
    outcomeChanged: boolean;
  };
}

export interface AbSummary {
  ranAt: string;
  currentRef: string;
  baselineRef: string;
  rowCount: number;
  rows: RowDiff[];
  summary: {
    currentPassRate: number;
    baselinePassRate: number;
    currentAvgCostMinutes: number;
    baselineAvgCostMinutes: number;
    passRateDelta: number;
    costDeltaMinutes: number;
  };
}

/** Shape of the per-version runner's output (see scripts/eval/run-eval-replay.ts). */
export interface RunnerSummary {
  tasks: Array<{
    evalId: string;
    status: string;
    durationMs: number;
    costUsd?: number | null;
  }>;
}

/** Single eval-set row (minimal subset). */
export interface EvalRow {
  id: string;
  pr_url?: string;
}

// ---- Pure helpers ----

export function parseArgs(argv: readonly string[]): AbCliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const baseline = get('--baseline');
  if (!baseline) {
    throw new Error('--baseline <git-ref> is required');
  }
  const current = get('--current') ?? 'HEAD';
  const limitRaw = get('--limit');
  const limit = limitRaw === undefined ? null : Number.parseInt(limitRaw, 10);
  if (limit !== null && !Number.isFinite(limit)) {
    throw new Error(`--limit must be a number, got ${limitRaw}`);
  }
  const outputPath = get('--output') ?? join(process.cwd(), '.ifleet/eval/replay-results.json');
  const worktreeRoot = get('--worktree-root') ?? tmpdir();
  const runnerScript = get('--runner') ?? 'scripts/eval/run-eval-replay.ts';

  return {
    baseline,
    current,
    limit,
    dryRun: has('--dry-run'),
    outputPath: resolve(outputPath),
    worktreeRoot: resolve(worktreeRoot),
    runnerScript,
  };
}

export function readEvalRows(path: string, limit: number | null): EvalRow[] {
  const text = readFileSync(path, 'utf8');
  const rows: EvalRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as EvalRow);
    if (limit !== null && rows.length >= limit) break;
  }
  return rows;
}

const USD_PER_MINUTE = 0.05;

export function costMinutesFromTask(task: RunnerSummary['tasks'][number]): number {
  const usd = task.costUsd ?? 0;
  if (usd > 0) return +(usd / USD_PER_MINUTE).toFixed(3);
  return +(task.durationMs / 60_000).toFixed(3);
}

export function normalizeRunnerSummary(
  summary: RunnerSummary,
  evalRowsById: Map<string, EvalRow>,
): RowOutcome[] {
  return summary.tasks.map((t) => ({
    evalId: t.evalId,
    verifierPassed: t.status === 'passed' || t.status === 'partial',
    costMinutes: costMinutesFromTask(t),
    prUrl: evalRowsById.get(t.evalId)?.pr_url ?? null,
  }));
}

export function computeDiff(
  current: readonly RowOutcome[],
  baseline: readonly RowOutcome[],
): RowDiff[] {
  const currentById = new Map(current.map((r) => [r.evalId, r] as const));
  const baselineById = new Map(baseline.map((r) => [r.evalId, r] as const));
  const allIds = new Set<string>([...currentById.keys(), ...baselineById.keys()]);
  const rows: RowDiff[] = [];
  for (const id of allIds) {
    const c = currentById.get(id) ?? null;
    const b = baselineById.get(id) ?? null;
    const costMinutesDelta =
      c && b ? +(c.costMinutes - b.costMinutes).toFixed(3) : null;
    const outcomeChanged =
      c && b ? c.verifierPassed !== b.verifierPassed : true;
    rows.push({ evalId: id, current: c, baseline: b, diff: { costMinutesDelta, outcomeChanged } });
  }
  rows.sort((a, b) => a.evalId.localeCompare(b.evalId));
  return rows;
}

export function computeSummary(rows: readonly RowDiff[]): AbSummary['summary'] {
  const currentRows = rows.map((r) => r.current).filter((r): r is RowOutcome => r !== null);
  const baselineRows = rows.map((r) => r.baseline).filter((r): r is RowOutcome => r !== null);

  const passRate = (rs: readonly RowOutcome[]): number =>
    rs.length === 0 ? 0 : +(rs.filter((r) => r.verifierPassed).length / rs.length).toFixed(4);
  const avgCost = (rs: readonly RowOutcome[]): number =>
    rs.length === 0 ? 0 : +(rs.reduce((s, r) => s + r.costMinutes, 0) / rs.length).toFixed(3);

  const currentPassRate = passRate(currentRows);
  const baselinePassRate = passRate(baselineRows);
  const currentAvgCostMinutes = avgCost(currentRows);
  const baselineAvgCostMinutes = avgCost(baselineRows);

  return {
    currentPassRate,
    baselinePassRate,
    currentAvgCostMinutes,
    baselineAvgCostMinutes,
    passRateDelta: +(currentPassRate - baselinePassRate).toFixed(4),
    costDeltaMinutes: +(currentAvgCostMinutes - baselineAvgCostMinutes).toFixed(3),
  };
}

// ---- IO layer (worktrees + runner invocation) ----

export interface WorktreeRunDeps {
  spawn?: typeof spawnSync;
  read?: typeof readFileSync;
  log?: (msg: string) => void;
}

export interface WorktreeRunOptions {
  ref: string;
  label: 'baseline' | 'current';
  repoRoot: string;
  worktreeRoot: string;
  limit: number | null;
  runnerScript: string;
}

export function resolveRefToSha(
  ref: string,
  repoRoot: string,
  spawn: typeof spawnSync = spawnSync,
): string {
  const r = spawn('git', ['rev-parse', ref], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${r.stderr?.trim() ?? 'unknown error'}`);
  }
  return (r.stdout ?? '').trim();
}

export function runVersionInWorktree(
  opts: WorktreeRunOptions,
  deps: WorktreeRunDeps = {},
): RunnerSummary {
  const spawn = deps.spawn ?? spawnSync;
  const read = deps.read ?? readFileSync;
  const log = deps.log ?? ((m: string) => console.log(m));

  const dir = mkdtempSync(join(opts.worktreeRoot, `ifleet-eval-ab-${opts.label}-`));
  log(`[ab-replay] ${opts.label}: worktree → ${dir} @ ${opts.ref}`);

  const add = spawn('git', ['worktree', 'add', '--detach', dir, opts.ref], {
    cwd: opts.repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (add.status !== 0) {
    throw new Error(
      `git worktree add for ${opts.ref} failed: ${add.stderr?.slice(0, 400) ?? 'unknown'}`,
    );
  }

  const install = spawn('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (install.status !== 0) {
    log(`[ab-replay] ${opts.label}: pnpm install non-zero exit ${install.status} (continuing)`);
  }

  const runnerArgs = [
    'tsx',
    opts.runnerScript,
    ...(opts.limit !== null ? ['--limit', String(opts.limit)] : []),
  ];
  const run = spawn('pnpm', runnerArgs, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30 * 60_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (run.status !== 0) {
    log(`[ab-replay] ${opts.label}: runner exit ${run.status} (still reading results.json)`);
  }

  const resultsPath = join(dir, '.ifleet/eval/replay-results.json');
  if (!existsSync(resultsPath)) {
    throw new Error(`runner produced no replay-results.json at ${resultsPath}`);
  }
  return JSON.parse(read(resultsPath, 'utf8') as string) as RunnerSummary;
}

// ---- Main ----

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const evalSetPath = join(repoRoot, '.ifleet/eval/eval-set.jsonl');

  if (!existsSync(evalSetPath)) {
    console.error(`[ab-replay] eval-set not found at ${evalSetPath}`);
    process.exit(1);
  }

  const baselineSha = resolveRefToSha(args.baseline, repoRoot);
  const currentSha = resolveRefToSha(args.current, repoRoot);
  console.log(`[ab-replay] baseline ${args.baseline} → ${baselineSha.slice(0, 8)}`);
  console.log(`[ab-replay] current  ${args.current}  → ${currentSha.slice(0, 8)}`);
  console.log(`[ab-replay] limit: ${args.limit ?? 'all'}`);

  const evalRows = readEvalRows(evalSetPath, args.limit);
  const evalRowsById = new Map(evalRows.map((r) => [r.id, r] as const));
  console.log(`[ab-replay] eval rows: ${evalRows.length}`);

  if (args.dryRun) {
    console.log('[ab-replay] --dry-run: skipping worktree creation and pipeline execution');
    const planned: AbSummary = {
      ranAt: new Date().toISOString(),
      currentRef: currentSha,
      baselineRef: baselineSha,
      rowCount: evalRows.length,
      rows: evalRows.map((r) => ({
        evalId: r.id,
        current: null,
        baseline: null,
        diff: { costMinutesDelta: null, outcomeChanged: false },
      })),
      summary: computeSummary([]),
    };
    writeFileSync(args.outputPath, JSON.stringify(planned, null, 2));
    console.log(`[ab-replay] dry-run plan written → ${args.outputPath}`);
    return;
  }

  const baselineSummary = runVersionInWorktree({
    ref: args.baseline,
    label: 'baseline',
    repoRoot,
    worktreeRoot: args.worktreeRoot,
    limit: args.limit,
    runnerScript: args.runnerScript,
  });
  const currentSummary = runVersionInWorktree({
    ref: args.current,
    label: 'current',
    repoRoot,
    worktreeRoot: args.worktreeRoot,
    limit: args.limit,
    runnerScript: args.runnerScript,
  });

  const baselineRows = normalizeRunnerSummary(baselineSummary, evalRowsById);
  const currentRows = normalizeRunnerSummary(currentSummary, evalRowsById);
  const rowDiffs = computeDiff(currentRows, baselineRows);
  const summary = computeSummary(rowDiffs);

  const out: AbSummary = {
    ranAt: new Date().toISOString(),
    currentRef: currentSha,
    baselineRef: baselineSha,
    rowCount: rowDiffs.length,
    rows: rowDiffs,
    summary,
  };
  writeFileSync(args.outputPath, JSON.stringify(out, null, 2));
  console.log(`[ab-replay] wrote A/B summary → ${args.outputPath}`);
  console.log(
    `[ab-replay] pass rate: current ${summary.currentPassRate} vs baseline ${summary.baselinePassRate} (Δ ${summary.passRateDelta})`,
  );
  console.log(
    `[ab-replay] cost minutes: current ${summary.currentAvgCostMinutes} vs baseline ${summary.baselineAvgCostMinutes} (Δ ${summary.costDeltaMinutes})`,
  );
}

const invokedDirectly = process.argv[1]?.endsWith('eval-replay-ab.ts') === true;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('[ab-replay] fatal:', err);
    process.exit(1);
  });
}
