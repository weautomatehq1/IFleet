import { describe, it, expect, vi } from 'vitest';
import {
  assertCrossProviderRule,
  CrossProviderRuleViolation,
  parseGateOutput,
  parseVerdict,
  runReviewer,
} from '../reviewer.js';
import type { WorkerSpec } from '../types.js';
import { makeMockWorkerPool } from './helpers.js';

const claude: WorkerSpec = { provider: 'claude', model: 'opus', workerId: 'c1' };
const codex: WorkerSpec = { provider: 'codex', model: 'gpt-5.5', workerId: 'x1' };

describe('cross-provider rule', () => {
  it('throws when reviewer matches editor provider (claude/claude) — multi-provider pool', () => {
    const pool = new Set(['claude', 'codex']);
    expect(() => assertCrossProviderRule(claude, claude, pool)).toThrow(CrossProviderRuleViolation);
  });

  it('throws when reviewer matches editor provider (codex/codex) — multi-provider pool', () => {
    const pool = new Set(['claude', 'codex']);
    expect(() => assertCrossProviderRule(codex, codex, pool)).toThrow(CrossProviderRuleViolation);
  });

  it('throws with no pool arg (strict default)', () => {
    expect(() => assertCrossProviderRule(claude, claude)).toThrow(CrossProviderRuleViolation);
  });

  it('warns and does not throw in single-provider pool (claude/claude)', () => {
    const pool = new Set(['claude']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertCrossProviderRule(claude, claude, pool)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cross-provider rule skipped'));
    warn.mockRestore();
  });

  it('passes when reviewer is the opposite provider (claude editor, codex reviewer)', () => {
    expect(() => assertCrossProviderRule(claude, codex)).not.toThrow();
  });

  it('passes when reviewer is the opposite provider (codex editor, claude reviewer)', () => {
    expect(() => assertCrossProviderRule(codex, claude)).not.toThrow();
  });
});

describe('parseVerdict', () => {
  it('parses an approve verdict', () => {
    const v = parseVerdict('{"verdict":"approve","concerns":[]}');
    expect(v.verdict).toBe('approve');
    expect(v.concerns).toEqual([]);
  });

  it('parses a request_changes verdict with concerns', () => {
    const v = parseVerdict('{"verdict":"request_changes","concerns":["x.ts:1 bad"]}');
    expect(v.verdict).toBe('request_changes');
    expect(v.concerns).toEqual(['x.ts:1 bad']);
  });

  it('tolerates leading/trailing prose around JSON', () => {
    const v = parseVerdict('here is my review:\n{"verdict":"approve","concerns":[]}\nthanks');
    expect(v.verdict).toBe('approve');
  });

  it('falls back to request_changes when JSON is malformed', () => {
    const v = parseVerdict('definitely not json');
    expect(v.verdict).toBe('request_changes');
    expect(v.concerns[0]).toMatch(/no parseable JSON|malformed/);
  });

  it('rejects an invalid verdict value', () => {
    const v = parseVerdict('{"verdict":"maybe","concerns":[]}');
    expect(v.verdict).toBe('request_changes');
  });
});

describe('parseGateOutput', () => {
  it('treats bare CLEAN as clean', () => {
    expect(parseGateOutput('CLEAN').kind).toBe('clean');
  });
  it('tolerates whitespace and quotes around CLEAN', () => {
    expect(parseGateOutput('  "CLEAN"  \n').kind).toBe('clean');
  });
  it('escalates on REVIEW_NEEDED with reason', () => {
    const r = parseGateOutput('REVIEW_NEEDED: missing null check in handler');
    expect(r.kind).toBe('escalate');
    if (r.kind === 'escalate') expect(r.reason).toContain('null check');
  });
  it('escalates on unrecognized output rather than approving', () => {
    const r = parseGateOutput('I think this looks fine to me');
    expect(r.kind).toBe('escalate');
  });
  it('errors on empty output', () => {
    expect(parseGateOutput('   ').kind).toBe('error');
  });
});

describe('runReviewer haiku gate', () => {
  const editor: WorkerSpec = { provider: 'codex', model: 'gpt-5.5', workerId: 'codex-1' };
  const reviewer: WorkerSpec = { provider: 'claude', model: 'opus', workerId: 'claude-reviewer-1' };
  const gate: WorkerSpec = { provider: 'claude', model: 'haiku', workerId: 'claude-gate-1' };
  const controller = new AbortController();

  it('CLEAN gate short-circuits: full reviewer is NOT spawned', async () => {
    const pool = makeMockWorkerPool([{ role: 'reviewer', output: 'CLEAN' }]);
    const out = await runReviewer({
      editorSpec: editor,
      reviewerSpec: reviewer,
      haikuGateSpec: gate,
      workerPool: pool,
      brief: 'b',
      plan: 'p',
      diff: 'd',
      abortSignal: controller.signal,
    });
    expect(out.gate).toBe('haiku');
    expect(out.verdict.verdict).toBe('approve');
    expect(out.attempt.workerId).toBe('claude-gate-1');
    expect(out.attempt.gate).toBe('haiku');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.spec.workerId).toBe('claude-gate-1');
  });

  it('REVIEW_NEEDED gate → full reviewer runs and its verdict wins', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: 'REVIEW_NEEDED: changes auth flow' },
      { role: 'reviewer', output: '{"verdict":"request_changes","concerns":["x.ts:1 bad"]}' },
    ]);
    const out = await runReviewer({
      editorSpec: editor,
      reviewerSpec: reviewer,
      haikuGateSpec: gate,
      workerPool: pool,
      brief: 'b',
      plan: 'p',
      diff: 'd',
      abortSignal: controller.signal,
    });
    expect(out.gate).toBe('full');
    expect(out.verdict.verdict).toBe('request_changes');
    expect(out.verdict.concerns).toContain('x.ts:1 bad');
    expect(out.attempt.workerId).toBe('claude-reviewer-1');
    expect(out.attempt.gate).toBe('full');
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0]?.spec.workerId).toBe('claude-gate-1');
    expect(pool.calls[1]?.spec.workerId).toBe('claude-reviewer-1');
  });

  it('gate worker error → full reviewer runs (safe fallback)', async () => {
    // Script the gate spawn to return ok=false; the full reviewer must still
    // execute and approve. Without the fallback, an unreliable haiku could
    // silently block every review.
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: '', ok: false },
      { role: 'reviewer', output: '{"verdict":"approve","concerns":[]}' },
    ]);
    const out = await runReviewer({
      editorSpec: editor,
      reviewerSpec: reviewer,
      haikuGateSpec: gate,
      workerPool: pool,
      brief: 'b',
      plan: 'p',
      diff: 'd',
      abortSignal: controller.signal,
    });
    expect(out.gate).toBe('full');
    expect(out.verdict.verdict).toBe('approve');
    expect(pool.calls).toHaveLength(2);
  });

  it('no gate spec → full reviewer runs immediately (backwards compat)', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: '{"verdict":"approve","concerns":[]}' },
    ]);
    const out = await runReviewer({
      editorSpec: editor,
      reviewerSpec: reviewer,
      workerPool: pool,
      brief: 'b',
      plan: 'p',
      diff: 'd',
      abortSignal: controller.signal,
    });
    expect(out.gate).toBe('full');
    expect(out.verdict.verdict).toBe('approve');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.spec.workerId).toBe('claude-reviewer-1');
  });
});
