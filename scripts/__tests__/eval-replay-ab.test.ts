import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  parseArgs,
  readEvalRows,
  costMinutesFromTask,
  normalizeRunnerSummary,
  computeDiff,
  computeSummary,
  resolveRefToSha,
  runVersionInWorktree,
  type RunnerSummary,
  type RowOutcome,
  type EvalRow,
} from '../eval-replay-ab.js';

function ok(stdout: string): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: ['', stdout, ''],
    stdout,
    stderr: '',
    status: 0,
    signal: null,
  };
}

function fail(stderr: string, status = 1): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: ['', '', stderr],
    stdout: '',
    stderr,
    status,
    signal: null,
  };
}

describe('parseArgs', () => {
  it('requires --baseline', () => {
    expect(() => parseArgs([])).toThrow(/--baseline/);
  });

  it('defaults --current to HEAD and limit to null', () => {
    const args = parseArgs(['--baseline', 'HEAD~5']);
    expect(args.baseline).toBe('HEAD~5');
    expect(args.current).toBe('HEAD');
    expect(args.limit).toBeNull();
    expect(args.dryRun).toBe(false);
  });

  it('parses --limit, --current, --dry-run', () => {
    const args = parseArgs(['--baseline', 'abc', '--current', 'def', '--limit', '3', '--dry-run']);
    expect(args.baseline).toBe('abc');
    expect(args.current).toBe('def');
    expect(args.limit).toBe(3);
    expect(args.dryRun).toBe(true);
  });

  it('rejects non-numeric --limit', () => {
    expect(() => parseArgs(['--baseline', 'x', '--limit', 'banana'])).toThrow(/--limit/);
  });
});

describe('readEvalRows', () => {
  it('parses JSONL respecting --limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-test-'));
    const file = join(dir, 'eval.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ id: 'a', pr_url: 'https://gh/p/1' }),
        JSON.stringify({ id: 'b', pr_url: 'https://gh/p/2' }),
        '',
        JSON.stringify({ id: 'c' }),
      ].join('\n'),
    );
    const rows = readEvalRows(file, 2);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    const all = readEvalRows(file, null);
    expect(all.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    rmSync(dir, { recursive: true });
  });
});

describe('costMinutesFromTask', () => {
  it('prefers costUsd when present', () => {
    expect(costMinutesFromTask({ evalId: 'x', status: 'passed', durationMs: 999, costUsd: 0.5 })).toBe(10);
  });
  it('falls back to duration when costUsd is zero/null', () => {
    expect(costMinutesFromTask({ evalId: 'x', status: 'passed', durationMs: 120_000, costUsd: 0 })).toBe(2);
    expect(costMinutesFromTask({ evalId: 'x', status: 'passed', durationMs: 60_000, costUsd: null })).toBe(1);
  });
});

describe('normalizeRunnerSummary', () => {
  it('maps status passed|partial → verifierPassed=true and attaches pr_url', () => {
    const rows: EvalRow[] = [
      { id: 'a', pr_url: 'https://gh/p/1' },
      { id: 'b', pr_url: 'https://gh/p/2' },
    ];
    const summary: RunnerSummary = {
      tasks: [
        { evalId: 'a', status: 'passed', durationMs: 60_000, costUsd: 0 },
        { evalId: 'b', status: 'failed', durationMs: 30_000 },
        { evalId: 'c', status: 'partial', durationMs: 12_000 },
      ],
    };
    const result = normalizeRunnerSummary(summary, new Map(rows.map((r) => [r.id, r])));
    expect(result).toEqual([
      { evalId: 'a', verifierPassed: true, costMinutes: 1, prUrl: 'https://gh/p/1' },
      { evalId: 'b', verifierPassed: false, costMinutes: 0.5, prUrl: 'https://gh/p/2' },
      { evalId: 'c', verifierPassed: true, costMinutes: 0.2, prUrl: null },
    ]);
  });
});

describe('computeDiff', () => {
  it('aligns rows by evalId and computes per-row delta', () => {
    const current: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 1.0, prUrl: null },
      { evalId: 'b', verifierPassed: false, costMinutes: 2.0, prUrl: null },
    ];
    const baseline: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 1.5, prUrl: null },
      { evalId: 'c', verifierPassed: true, costMinutes: 0.5, prUrl: null },
    ];
    const rows = computeDiff(current, baseline);
    expect(rows).toHaveLength(3);
    const byId = Object.fromEntries(rows.map((r) => [r.evalId, r]));
    expect(byId['a']?.diff).toEqual({ costMinutesDelta: -0.5, outcomeChanged: false });
    expect(byId['b']?.diff).toEqual({ costMinutesDelta: null, outcomeChanged: true });
    expect(byId['c']?.diff).toEqual({ costMinutesDelta: null, outcomeChanged: true });
  });
});

describe('computeSummary', () => {
  it('computes pass rates, avg cost, and deltas', () => {
    const current: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 1.0, prUrl: null },
      { evalId: 'b', verifierPassed: true, costMinutes: 2.0, prUrl: null },
    ];
    const baseline: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 2.0, prUrl: null },
      { evalId: 'b', verifierPassed: false, costMinutes: 3.0, prUrl: null },
    ];
    const rows = computeDiff(current, baseline);
    const s = computeSummary(rows);
    expect(s.currentPassRate).toBe(1);
    expect(s.baselinePassRate).toBe(0.5);
    expect(s.passRateDelta).toBe(0.5);
    expect(s.currentAvgCostMinutes).toBe(1.5);
    expect(s.baselineAvgCostMinutes).toBe(2.5);
    expect(s.costDeltaMinutes).toBe(-1);
  });

  it('returns zeros for empty rows', () => {
    const s = computeSummary([]);
    expect(s.currentPassRate).toBe(0);
    expect(s.baselinePassRate).toBe(0);
    expect(s.passRateDelta).toBe(0);
    expect(s.costDeltaMinutes).toBe(0);
  });
});

describe('resolveRefToSha', () => {
  it('returns trimmed stdout on success', () => {
    const sha = resolveRefToSha('HEAD', '/repo', (() => ok('abc123\n')) as never);
    expect(sha).toBe('abc123');
  });

  it('throws on non-zero exit', () => {
    expect(() =>
      resolveRefToSha('bogus', '/repo', (() => fail('unknown revision')) as never),
    ).toThrow(/git rev-parse bogus failed/);
  });
});

describe('runVersionInWorktree', () => {
  it('invokes git worktree add, pnpm install, and the runner; reads the results file', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSummary: RunnerSummary = {
      tasks: [{ evalId: 'a', status: 'passed', durationMs: 60_000, costUsd: 0 }],
    };
    const spawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        // ['worktree','add','--detach',<dir>,<ref>]
        const dir = args[args.length - 2] as string;
        const evalDir = join(dir, '.ifleet/eval');
        mkdirSync(evalDir, { recursive: true });
        writeFileSync(join(evalDir, 'replay-results.json'), JSON.stringify(fakeSummary));
      }
      return ok('') as SpawnSyncReturns<string>;
    }) as unknown as typeof import('node:child_process').spawnSync;

    const root = mkdtempSync(join(tmpdir(), 'ab-wt-root-'));
    const summary = runVersionInWorktree(
      {
        ref: 'HEAD',
        label: 'current',
        repoRoot: '/repo',
        worktreeRoot: root,
        limit: 2,
        runnerScript: 'scripts/eval/run-eval-replay.ts',
      },
      { spawn, log: () => {} },
    );
    expect(summary.tasks).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['worktree', 'add', '--detach']);
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args[0] === 'install')).toBeDefined();
    expect(calls.find((c) => c.cmd === 'pnpm' && c.args.includes('--limit'))).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws when git worktree add fails', () => {
    const spawn = ((cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args[0] === 'worktree') return fail('bad ref');
      return ok('');
    }) as unknown as typeof import('node:child_process').spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'ab-wt-fail-'));
    expect(() =>
      runVersionInWorktree(
        {
          ref: 'bogus',
          label: 'baseline',
          repoRoot: '/repo',
          worktreeRoot: root,
          limit: null,
          runnerScript: 'scripts/eval/run-eval-replay.ts',
        },
        { spawn, log: () => {} },
      ),
    ).toThrow(/git worktree add for bogus failed/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('output file shape (integration of pure functions)', () => {
  it('writes a JSON file that matches the documented shape', () => {
    const current: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 1.2, prUrl: 'https://gh/p/1' },
    ];
    const baseline: RowOutcome[] = [
      { evalId: 'a', verifierPassed: true, costMinutes: 1.5, prUrl: 'https://gh/p/1' },
    ];
    const rows = computeDiff(current, baseline);
    const summary = computeSummary(rows);
    const out = {
      ranAt: '2026-05-21T00:00:00Z',
      currentRef: 'aaaa',
      baselineRef: 'bbbb',
      rowCount: rows.length,
      rows,
      summary,
    };
    const dir = mkdtempSync(join(tmpdir(), 'ab-out-'));
    const path = join(dir, 'r.json');
    writeFileSync(path, JSON.stringify(out, null, 2));
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof out;
    expect(parsed.summary.costDeltaMinutes).toBe(-0.3);
    expect(parsed.rows[0]?.diff.outcomeChanged).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
