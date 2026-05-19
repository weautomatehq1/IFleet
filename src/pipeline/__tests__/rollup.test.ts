import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRollupPrompt,
  collectLearnings,
  dedupeLearnings,
  DISCORD_DAILY_BRIEF_LIMIT,
  formatRollupFallback,
  parseLearningsFile,
  type LearningEntry,
} from '../rollup.js';

const SAMPLE_FILE = `
# Learnings — IFleet

- 2026-05-18 09:15 | T-76 | doctor caught a flaky verify step before it propagated
- 2026-05-18 10:02 | T-72 | classifier downgraded a Sonnet job to Haiku — bad call
malformed line, should be ignored
- 2026-05-17 18:44 | T-69 | learnings file was missing trailing newline
`.trim();

describe('parseLearningsFile', () => {
  it('parses well-formed entries and ignores junk', () => {
    const out = parseLearningsFile(SAMPLE_FILE, 'IFleet');
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      ts: '2026-05-18 09:15',
      taskId: 'T-76',
      text: 'doctor caught a flaky verify step before it propagated',
      repo: 'IFleet',
    });
  });

  it('returns [] for empty input', () => {
    expect(parseLearningsFile('', 'X')).toEqual([]);
  });
});

describe('collectLearnings', () => {
  function makeRepo(content: string, name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `rollup-${name}-`));
    mkdirSync(join(dir, '.omc'), { recursive: true });
    writeFileSync(join(dir, '.omc', 'learnings.md'), content, 'utf8');
    return dir;
  }

  it('walks repoRoots and returns entries newest-first', () => {
    const a = makeRepo(
      '- 2026-05-18 09:15 | T-1 | a-newer\n- 2026-05-17 09:15 | T-1 | a-older',
      'a',
    );
    const b = makeRepo('- 2026-05-18 10:00 | T-2 | b-newest', 'b');
    const out = collectLearnings({ repoRoots: [a, b] });
    expect(out.map((e) => e.text)).toEqual(['b-newest', 'a-newer', 'a-older']);
  });

  it('honors sinceTs cutoff', () => {
    const a = makeRepo(
      '- 2026-05-18 09:15 | T-1 | new\n- 2026-05-17 09:15 | T-1 | old',
      'cutoff',
    );
    const out = collectLearnings({ repoRoots: [a], sinceTs: '2026-05-18 00:00' });
    expect(out.map((e) => e.text)).toEqual(['new']);
  });

  it('silently skips repos with no learnings file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rollup-empty-'));
    expect(collectLearnings({ repoRoots: [empty] })).toEqual([]);
  });
});

describe('dedupeLearnings', () => {
  it('keeps the first occurrence (newest after sort)', () => {
    const entries: LearningEntry[] = [
      { ts: '2026-05-18 10:00', taskId: 'a', text: 'use real DB in tests', repo: 'r1' },
      { ts: '2026-05-18 09:00', taskId: 'b', text: 'use real DB in tests', repo: 'r2' },
      { ts: '2026-05-18 08:00', taskId: 'c', text: 'unique', repo: 'r3' },
    ];
    const out = dedupeLearnings(entries);
    expect(out).toHaveLength(2);
    expect(out[0]!.repo).toBe('r1');
  });

  it('is case-insensitive', () => {
    const entries: LearningEntry[] = [
      { ts: '2026-05-18 10:00', taskId: 'a', text: 'Use Real DB', repo: 'r1' },
      { ts: '2026-05-18 09:00', taskId: 'b', text: 'use real db', repo: 'r2' },
    ];
    expect(dedupeLearnings(entries)).toHaveLength(1);
  });
});

describe('formatRollupFallback', () => {
  it('reports "no learnings" when empty', () => {
    expect(formatRollupFallback([])).toMatch(/no new learnings/);
  });

  it('caps output at maxChars and emits a "more" tail', () => {
    const entries: LearningEntry[] = Array.from({ length: 200 }, (_, i) => ({
      ts: '2026-05-18 09:00',
      taskId: `T-${i}`,
      text: 'lorem ipsum dolor sit amet '.repeat(3),
      repo: 'demo',
    }));
    const out = formatRollupFallback(entries, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/and \d+ more/);
  });

  it('default limit fits in Discord message cap', () => {
    expect(DISCORD_DAILY_BRIEF_LIMIT).toBeLessThan(2000);
  });
});

describe('buildRollupPrompt', () => {
  it('includes repo, ts, taskId, text and caps at 50 entries', () => {
    const entries: LearningEntry[] = Array.from({ length: 75 }, (_, i) => ({
      ts: '2026-05-18 09:00',
      taskId: `T-${i}`,
      text: `entry ${i}`,
      repo: 'r',
    }));
    const out = buildRollupPrompt(entries);
    expect(out).toContain('[r] 2026-05-18 09:00 T-0: entry 0');
    expect(out).toContain('T-49');
    expect(out).not.toContain('T-50');
  });
});
