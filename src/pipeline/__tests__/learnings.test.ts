import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLearnings,
  formatPriorLearningsSection,
  LEARNINGS_RELATIVE_PATH,
  parseLearningBlocks,
  PRIOR_LEARNINGS_HEADER,
  readRecentLearnings,
} from '../learnings.js';

describe('learnings', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ifleet-learnings-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe('readRecentLearnings', () => {
    it('returns [] when the file is missing', async () => {
      const out = await readRecentLearnings(repoRoot);
      expect(out).toEqual([]);
    });

    it('returns the trailing N entries when limit < line count', async () => {
      await mkdir(join(repoRoot, '.omc'), { recursive: true });
      const lines = Array.from({ length: 60 }, (_, i) => `- 2026-05-18 21:${i.toString().padStart(2, '0')} | task-${i} | lesson ${i}`);
      await writeFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), `${lines.join('\n')}\n`, 'utf8');
      const out = await readRecentLearnings(repoRoot, 10);
      expect(out).toHaveLength(10);
      expect(out[0]).toBe('- 2026-05-18 21:50 | task-50 | lesson 50');
      expect(out[9]).toBe('- 2026-05-18 21:59 | task-59 | lesson 59');
    });

    it('ignores blank lines', async () => {
      await mkdir(join(repoRoot, '.omc'), { recursive: true });
      await writeFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), '\n\n- one\n\n- two\n\n', 'utf8');
      const out = await readRecentLearnings(repoRoot);
      expect(out).toEqual(['- one', '- two']);
    });
  });

  describe('parseLearningBlocks', () => {
    it('extracts every <learning>…</learning> block', () => {
      const out = parseLearningBlocks(`
plan text
<learning>repo uses pnpm not npm</learning>
more text
<learning>tests live in src/**/__tests__</learning>
end
`);
      expect(out).toEqual(['repo uses pnpm not npm', 'tests live in src/**/__tests__']);
    });

    it('returns [] when no blocks present', () => {
      expect(parseLearningBlocks('just plan text, no blocks')).toEqual([]);
    });

    it('collapses internal whitespace and skips empty blocks', () => {
      const out = parseLearningBlocks(`
<learning>
  multi
  line
  lesson
</learning>
<learning>   </learning>
`);
      expect(out).toEqual(['multi line lesson']);
    });
  });

  describe('appendLearnings', () => {
    it('creates the file and writes one line per learning with the timestamp + task id', async () => {
      const now = new Date(Date.UTC(2026, 4, 18, 21, 15));
      await appendLearnings(repoRoot, 'task-69', ['repo uses pnpm not npm', 'tests in __tests__'], now);
      const content = await readFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), 'utf8');
      expect(content).toBe(
        '- 2026-05-18 21:15 | task-69 | repo uses pnpm not npm\n- 2026-05-18 21:15 | task-69 | tests in __tests__\n',
      );
    });

    it('appends to an existing file without truncating', async () => {
      await mkdir(join(repoRoot, '.omc'), { recursive: true });
      await writeFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), '- existing line\n', 'utf8');
      const now = new Date(Date.UTC(2026, 4, 18, 21, 15));
      await appendLearnings(repoRoot, 'task-70', ['fresh insight'], now);
      const content = await readFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), 'utf8');
      expect(content).toBe('- existing line\n- 2026-05-18 21:15 | task-70 | fresh insight\n');
    });

    it('is a no-op when given an empty list', async () => {
      await appendLearnings(repoRoot, 'task-71', []);
      // No file should be created.
      await expect(readFile(join(repoRoot, LEARNINGS_RELATIVE_PATH), 'utf8')).rejects.toThrow();
    });
  });

  describe('formatPriorLearningsSection', () => {
    it('returns empty string for empty input (so callers can append without an extra branch)', () => {
      expect(formatPriorLearningsSection([])).toBe('');
    });

    it('emits the canonical header followed by lines', () => {
      const out = formatPriorLearningsSection(['- a', '- b']);
      expect(out.startsWith(`${PRIOR_LEARNINGS_HEADER}\n`)).toBe(true);
      expect(out).toContain('- a');
      expect(out).toContain('- b');
    });
  });
});
