import { describe, expect, it } from 'vitest';

import { defaultReadEvalSet, runShadowEval } from '../harness.js';
import type { ReplayDeps } from '../replay.js';
import type { EvalRow } from '../types.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function row(id: string, label: string, decision: string, files: string[]): EvalRow {
  return {
    id,
    issue_url: `https://example.com/issues/${id}`,
    pr_url: `https://example.com/pulls/${id}`,
    repo: 'weautomatehq1/IFleet',
    title: `task ${id}`,
    body: 'body',
    classifier_label_actual: label,
    diff_url: 'https://example.com/diff',
    diff_summary: 'summary',
    files_changed: files,
    loc_added: 1,
    loc_removed: 1,
    merged_at: '2026-05-19T10:00:00Z',
    reviewer_login: 'monstersebas1',
    merge_decision: decision,
    frozen_at: '2026-05-19T20:00:00Z',
  };
}

/**
 * Passthrough replay deps: architect + verifier echo what the row says,
 * so every row PASSes. Used to assert the harness wiring (totals, order,
 * timestamps) without coupling to comparator semantics.
 */
function passthroughDeps(): ReplayDeps {
  let n = 0;
  return {
    architect: {
      async plan(r) {
        return { filesChanged: r.files_changed, classifierLabel: r.classifier_label_actual };
      },
    },
    verifier: {
      async verify(_p, r) {
        return { mergeDecision: r.merge_decision };
      },
    },
    now: () => {
      n += 1;
      return n;
    },
  };
}

const FIXED_NOW = (): number => 1718500000000;

describe('runShadowEval', () => {
  it('replays every row through the seams and returns totals matching per-row verdicts', async () => {
    const rows = [
      row('r1', 'bugfix', 'merged_no_changes', ['src/a.ts']),
      row('r2', 'feature', 'merged_no_changes', ['src/b.ts']),
      row('r3', 'docs', 'closed_no_merge', ['README.md']),
    ];
    const summary = await runShadowEval({
      evalSetPath: '/dev/null',
      readEvalSet: async () => rows,
      replayDeps: passthroughDeps(),
      now: FIXED_NOW,
    });
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(3);
    expect(summary.results.map((r) => r.rowId)).toEqual(['r1', 'r2', 'r3']);
    expect(summary.runStartedAt).toBe(new Date(FIXED_NOW()).toISOString());
    expect(summary.runFinishedAt).toBe(new Date(FIXED_NOW()).toISOString());
  });

  it('counts per-row FAIL verdicts in the failed total', async () => {
    const rows = [
      row('r1', 'bugfix', 'merged_no_changes', ['src/a.ts']),
      row('r2', 'feature', 'merged_no_changes', ['src/b.ts']),
    ];
    const summary = await runShadowEval({
      evalSetPath: '/dev/null',
      readEvalSet: async () => rows,
      replayDeps: {
        architect: {
          async plan(r) {
            // Force a FAIL on r2 by emitting the wrong label.
            return {
              filesChanged: r.files_changed,
              classifierLabel: r.id === 'r2' ? 'wrong' : r.classifier_label_actual,
            };
          },
        },
        verifier: {
          async verify(_p, r) {
            return { mergeDecision: r.merge_decision };
          },
        },
        now: () => 0,
      },
      now: FIXED_NOW,
    });
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.verdict).toBe('PASS');
    expect(summary.results[1]!.verdict).toBe('FAIL');
    expect(summary.results[1]!.reason).toMatch(/classifierLabel/);
  });

  it('returns an empty summary on an empty eval-set without throwing', async () => {
    const summary = await runShadowEval({
      evalSetPath: '/dev/null',
      readEvalSet: async () => [],
      replayDeps: passthroughDeps(),
      now: FIXED_NOW,
    });
    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([]);
  });

  it('preserves per-row ordering even at concurrency > 1', async () => {
    const rows = [
      row('r1', 'bugfix', 'merged_no_changes', ['a']),
      row('r2', 'bugfix', 'merged_no_changes', ['b']),
      row('r3', 'bugfix', 'merged_no_changes', ['c']),
      row('r4', 'bugfix', 'merged_no_changes', ['d']),
    ];
    const summary = await runShadowEval({
      evalSetPath: '/dev/null',
      readEvalSet: async () => rows,
      replayDeps: passthroughDeps(),
      concurrency: 4,
      now: FIXED_NOW,
    });
    expect(summary.results.map((r) => r.rowId)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});

describe('defaultReadEvalSet', () => {
  it('parses a JSONL file, ignoring blank lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-eval-test-'));
    const path = join(dir, 'eval-set.jsonl');
    const rows = [
      row('r1', 'bugfix', 'merged_no_changes', ['src/a.ts']),
      row('r2', 'feature', 'merged_no_changes', ['src/b.ts']),
    ];
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n\n', 'utf8');
    const parsed = await defaultReadEvalSet(path);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.id).toBe('r1');
    expect(parsed[1]!.id).toBe('r2');
  });

  it('returns [] for an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadow-eval-test-'));
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '', 'utf8');
    expect(await defaultReadEvalSet(path)).toEqual([]);
  });
});
