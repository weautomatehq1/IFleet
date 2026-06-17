import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  parseClaimBlocks,
  validateBlock,
  normalizeValue,
  normalizeLabel,
  findMarkdownFiles,
  registerClaimType,
  isValidBaseRef,
  changedMarkdownFiles,
} from '../validate-claims.ts';
import type { ClaimTypeHandler } from '../validate-claims.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'validate-claims-'));
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ─── Normalization ─────────────────────────────────────────────────────────

describe('normalizeValue', () => {
  it('strips bold and code, collapses whitespace, lowercases', () => {
    expect(normalizeValue('  **9 / 10 (90%)**  ')).toBe('9 / 10 (90%)');
    expect(normalizeValue('`PASSED`')).toBe('passed');
    expect(normalizeValue('  multiple   spaces  ')).toBe('multiple spaces');
  });
});

describe('normalizeLabel', () => {
  it('slugifies for label keying', () => {
    expect(normalizeLabel('Pass rate')).toBe('passrate');
    expect(normalizeLabel('DoD gate (≥ 8 / 10)')).toBe('dodgate810');
    expect(normalizeLabel('Avg duration per run')).toBe('avgdurationperrun');
  });
});

// ─── Parser ────────────────────────────────────────────────────────────────

describe('parseClaimBlocks', () => {
  it('extracts a well-formed block with table rows', () => {
    const md = [
      '# Header',
      '',
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | **9 / 10** |',
      '| disagreementRate | 0.100 |',
      '<!-- /claim -->',
      '',
      'Trailing prose.',
    ].join('\n');
    const blocks = parseClaimBlocks('/fake/doc.md', md);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.type).toBe('replay-results');
    expect(b.src).toBe('.ifleet/eval/replay-results.json');
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0]?.label).toBe('Pass rate');
    expect(b.rows[0]?.value).toBe('**9 / 10**');
    expect(b.rows[1]?.label).toBe('disagreementRate');
  });

  it('handles multiple blocks in one file', () => {
    const md = [
      '<!-- claim:replay-results src="a.json" -->',
      '| M | V |',
      '|---|---|',
      '| Pass rate | 1/1 |',
      '<!-- /claim -->',
      '',
      'between',
      '',
      '<!-- claim:verifier-baseline src="b.json" -->',
      '| M | V |',
      '|---|---|',
      '| disagreementRate | 0.050 |',
      '<!-- /claim -->',
    ].join('\n');
    const blocks = parseClaimBlocks('/fake/doc.md', md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe('replay-results');
    expect(blocks[1]?.type).toBe('verifier-baseline');
  });

  it('ignores unclosed blocks', () => {
    const md = [
      '<!-- claim:replay-results src="a.json" -->',
      '| M | V |',
      '|---|---|',
      '| Pass rate | 1/1 |',
      '(no close)',
    ].join('\n');
    const blocks = parseClaimBlocks('/fake/doc.md', md);
    expect(blocks).toHaveLength(0);
  });

  it('skips claim blocks that appear inside fenced code blocks (docs showing examples)', () => {
    const md = [
      '# Documenting the format',
      '',
      'Example:',
      '',
      '```markdown',
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | 9/10 |',
      '<!-- /claim -->',
      '```',
      '',
      'A real block:',
      '',
      '<!-- claim:replay-results src="real.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | 1/1 |',
      '<!-- /claim -->',
    ].join('\n');
    const blocks = parseClaimBlocks('/fake/doc.md', md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.src).toBe('real.json');
  });

  it('returns no rows when content has no table', () => {
    const md = [
      '<!-- claim:replay-results src="a.json" -->',
      'Just prose, no pipes.',
      '<!-- /claim -->',
    ].join('\n');
    const blocks = parseClaimBlocks('/fake/doc.md', md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.rows).toHaveLength(0);
  });
});

// ─── Validator ─────────────────────────────────────────────────────────────

function replayData(overrides: Record<string, unknown> = {}): unknown {
  return {
    runAt: '2026-05-19T22:34:59.717Z',
    sandboxMode: 'real',
    taskLimit: 10,
    passingGate: 8,
    passedCount: 9,
    totalCount: 10,
    passRatePct: 90,
    disagreementRate: 0.1,
    avgDurationMs: 13000,
    totalCostUsd: 0,
    eventsEmitted: 20,
    dodGatePassed: true,
    tasks: [],
    ...overrides,
  };
}

describe('validateBlock', () => {
  it('passes when the table matches the JSON', () => {
    const root = tmpRoot();
    const ifleetDir = join(root, '.ifleet', 'eval');
    mkdirSync(ifleetDir, { recursive: true });
    writeJson(join(ifleetDir, 'replay-results.json'), replayData());

    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | **9 / 10 (90%)** |',
      '| DoD gate | ✓ PASSED |',
      '| disagreementRate | 0.100 |',
      '| Avg duration per run | 13000 ms |',
      '| Total cost | $0.00 |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.filter((f) => f.kind === 'mismatch')).toHaveLength(0);
    expect(findings.filter((f) => f.kind === 'missing-row')).toHaveLength(0);
  });

  it('flags the PR #128 fabrication shape (data says 0 passed, doc says 9)', () => {
    const root = tmpRoot();
    const ifleetDir = join(root, '.ifleet', 'eval');
    mkdirSync(ifleetDir, { recursive: true });
    // The actual PR #128 data: nothing ran, all errored
    writeJson(
      join(ifleetDir, 'replay-results.json'),
      replayData({
        passedCount: 0,
        totalCount: 10,
        passRatePct: 0,
        disagreementRate: null,
        dodGatePassed: false,
      }),
    );
    // The fabricated table:
    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | **9 / 10 (90%)** |',
      '| DoD gate (≥ 8 / 10) | ✓ PASSED |',
      '| disagreementRate | 0.100 |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    const mismatches = findings.filter((f) => f.kind === 'mismatch');
    expect(mismatches.length).toBeGreaterThanOrEqual(3);
    const labels = mismatches.map((m) => (m.kind === 'mismatch' ? m.row.label : ''));
    expect(labels).toContain('Pass rate');
    expect(labels).toContain('DoD gate (≥ 8 / 10)');
    expect(labels).toContain('disagreementRate');
  });

  it('reports missing-source when src does not exist', () => {
    const root = tmpRoot();
    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/not-there.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | 1/1 |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.some((f) => f.kind === 'missing-source')).toBe(true);
  });

  it('reports unknown-type for unregistered claim names', () => {
    const root = tmpRoot();
    const md = [
      '<!-- claim:made-up-thing src="x.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| foo | bar |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('unknown-type');
  });

  it('warns (not errors) on unknown rows and missing expected rows', () => {
    const root = tmpRoot();
    const ifleetDir = join(root, '.ifleet', 'eval');
    mkdirSync(ifleetDir, { recursive: true });
    writeJson(join(ifleetDir, 'replay-results.json'), replayData());
    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | 9 / 10 (90%) |',
      '| Some weird thing | whatever |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.some((f) => f.kind === 'unknown-row')).toBe(true);
    // Several expected rows aren't in the table (DoD gate, disagreementRate, etc.)
    expect(findings.some((f) => f.kind === 'missing-row')).toBe(true);
    // No mismatches
    expect(findings.some((f) => f.kind === 'mismatch')).toBe(false);
  });

  it('reports invalid-source on malformed JSON', () => {
    const root = tmpRoot();
    const ifleetDir = join(root, '.ifleet', 'eval');
    mkdirSync(ifleetDir, { recursive: true });
    writeFileSync(join(ifleetDir, 'replay-results.json'), '{not json');
    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Pass rate | 1/1 |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.some((f) => f.kind === 'invalid-source')).toBe(true);
  });

  it('accepts disagreementRate=null when source has null', () => {
    const root = tmpRoot();
    const ifleetDir = join(root, '.ifleet', 'eval');
    mkdirSync(ifleetDir, { recursive: true });
    writeJson(join(ifleetDir, 'replay-results.json'), replayData({ disagreementRate: null }));
    const md = [
      '<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| disagreementRate | null |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.some((f) => f.kind === 'mismatch')).toBe(false);
  });
});

// ─── Shell-injection hardening (AUDIT-IFleet-1bea4d5d / e2e32d03) ───────────

describe('isValidBaseRef', () => {
  it('accepts legitimate git refs', () => {
    expect(isValidBaseRef('origin/main')).toBe(true);
    expect(isValidBaseRef('main')).toBe(true);
    expect(isValidBaseRef('v1.2.3')).toBe(true);
    expect(isValidBaseRef('feature/foo-bar_baz')).toBe(true);
    expect(isValidBaseRef('a1b2c3d')).toBe(true);
  });

  it('rejects refs carrying shell metacharacters', () => {
    expect(isValidBaseRef('main; touch PWNED')).toBe(false);
    expect(isValidBaseRef("x'; rm -rf .; '")).toBe(false);
    expect(isValidBaseRef('$(rm -rf /)')).toBe(false);
    expect(isValidBaseRef('main && echo hi')).toBe(false);
    expect(isValidBaseRef('`id`')).toBe(false);
    expect(isValidBaseRef('a|b')).toBe(false);
    expect(isValidBaseRef('')).toBe(false);
  });
});

describe('changedMarkdownFiles — no shell injection', () => {
  it('does not execute an injected command and returns empty for a malicious --base', () => {
    const root = mkdtempSync(join(tmpdir(), 'validate-claims-inj-'));
    // Seed a real git repo so a *valid* base would actually run git, proving the
    // empty result below is the rejection path, not just "git failed anyway".
    execSync('git init -q && git config user.email t@t.t && git config user.name t', {
      cwd: root,
      shell: '/bin/sh',
    });
    writeFileSync(join(root, 'a.md'), '# hi');
    execSync('git add -A && git commit -qm init', { cwd: root, shell: '/bin/sh' });

    const sentinel = join(root, 'PWNED');
    // If `base` were interpolated into a shell string this would create the file.
    const malicious = `main; touch ${sentinel}`;
    const result = changedMarkdownFiles(malicious, root);

    expect(existsSync(sentinel)).toBe(false); // no shell execution
    expect(result.size).toBe(0); // rejected before reaching git
    rmSync(root, { recursive: true, force: true });
  });

  it('command-substitution payload never runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'validate-claims-inj2-'));
    const sentinel = join(root, 'OWNED');
    const result = changedMarkdownFiles(`$(touch ${sentinel})`, root);
    expect(existsSync(sentinel)).toBe(false);
    expect(result.size).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

// ─── Discovery ─────────────────────────────────────────────────────────────

describe('findMarkdownFiles', () => {
  it('walks directories and returns .md files only, skipping ignored dirs', () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'docs', 'a.md'), '');
    writeFileSync(join(root, 'docs', 'sub', 'b.md'), '');
    writeFileSync(join(root, 'docs', 'c.txt'), '');
    writeFileSync(join(root, 'node_modules', 'd.md'), '');
    const found = findMarkdownFiles([join(root, 'docs')]).sort();
    expect(found).toEqual([join(root, 'docs', 'a.md'), join(root, 'docs', 'sub', 'b.md')]);
  });
});

// ─── Registry extensibility ────────────────────────────────────────────────

describe('registerClaimType', () => {
  it('allows registering a new claim handler at runtime', () => {
    const root = tmpRoot();
    writeJson(join(root, 'thing.json'), { count: 42 });
    const handler: ClaimTypeHandler = {
      expectedRowLabels: ['Count'],
      resolve(data, label) {
        const d = data as { count: number };
        if (label.toLowerCase() === 'count') {
          return { jsonPath: 'count', expected: String(d.count) };
        }
        return null;
      },
    };
    registerClaimType('test-thing', handler);
    const md = [
      '<!-- claim:test-thing src="thing.json" -->',
      '| Metric | Value |',
      '|---|---|',
      '| Count | 42 |',
      '<!-- /claim -->',
    ].join('\n');
    const docPath = join(root, 'doc.md');
    writeFileSync(docPath, md);
    const block = parseClaimBlocks(docPath, md)[0]!;
    const findings = validateBlock(block, root);
    expect(findings.filter((f) => f.kind === 'mismatch')).toHaveLength(0);
  });
});
