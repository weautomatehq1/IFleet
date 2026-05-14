import { describe, it, expect, vi } from 'vitest';
import {
  assertCrossProviderRule,
  CrossProviderRuleViolation,
  parseVerdict,
} from '../reviewer.js';
import type { WorkerSpec } from '../types.js';

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
