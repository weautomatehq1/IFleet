/**
 * Failure parser unit tests — keep deliberately small fixtures inline so the
 * tests double as regression docs ("yes, vitest's text reporter prints this
 * shape; here's the failure we extract from it").
 */
import { describe, expect, it } from 'vitest';
import {
  parseTscOutput,
  parseEslintOutput,
  parseVitestOutput,
  parsePnpmInstallOutput,
  parseSemgrepJsonOutput,
  parseGenericBuildOutput,
  fallbackFailure,
  parsePhaseOutput,
} from '../failure-parser.js';

describe('parseTscOutput', () => {
  it('parses tsc paren-form errors', () => {
    const raw = `src/foo.ts(12,5): error TS2304: Cannot find name 'X'.\nsrc/bar.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.`;
    const out = parseTscOutput(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: 'typecheck',
      file: 'src/foo.ts',
      line: 12,
      column: 5,
      message: `Cannot find name 'X'.`,
    });
    expect(out[1]?.file).toBe('src/bar.ts');
  });

  it('parses tsc colon-form errors (pretty=false)', () => {
    const raw = `src/foo.ts:12:5 - error TS2304: Cannot find name 'X'.`;
    const out = parseTscOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'typecheck', file: 'src/foo.ts', line: 12, column: 5 });
  });

  it('dedupes identical lines from compound output', () => {
    // tsc with --pretty=false sometimes emits both forms — dedupe keeps the
    // retry feedback list short.
    const raw = `src/foo.ts(12,5): error TS2304: Cannot find name 'X'.\nsrc/foo.ts(12,5): error TS2304: Cannot find name 'X'.`;
    expect(parseTscOutput(raw)).toHaveLength(1);
  });
});

describe('parseEslintOutput', () => {
  it('parses stylish error rows with absolute paths', () => {
    const raw = `/work/src/foo.ts\n  12:5  error  'X' is not defined  no-undef\n  14:1  warning  Unexpected console.log  no-console\n`;
    const out = parseEslintOutput(raw);
    expect(out).toHaveLength(1); // warning excluded
    expect(out[0]).toMatchObject({
      kind: 'lint',
      file: 'src/foo.ts', // /work/ stripped
      line: 12,
      column: 5,
    });
    expect(out[0]?.message).toContain('no-undef');
  });
});

describe('parseVitestOutput', () => {
  it('parses FAIL block with location pointer', () => {
    const raw = ` FAIL  src/foo.test.ts > suite > expects something\n   AssertionError: expected 1 to equal 2\n      ❯ src/foo.test.ts:12:5\n`;
    const out = parseVitestOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'test',
      file: 'src/foo.test.ts',
      line: 12,
      column: 5,
    });
    expect(out[0]?.message).toContain('expected 1 to equal 2');
  });
});

describe('parsePnpmInstallOutput', () => {
  it('captures ERR_PNPM_* lines', () => {
    const raw = `ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/foo: Not found\n`;
    const out = parsePnpmInstallOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('ERR_PNPM_FETCH_404');
  });

  it('falls through to ELIFECYCLE when no ERR_PNPM matched', () => {
    const raw = `ELIFECYCLE  Command failed with exit code 1.\n`;
    const out = parsePnpmInstallOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('ELIFECYCLE');
  });

  it('does not double-report when both ERR_PNPM and ELIFECYCLE present', () => {
    const raw = `ERR_PNPM_FETCH_404 GET https://x: Not found\nELIFECYCLE  Command failed with exit code 1.\n`;
    expect(parsePnpmInstallOutput(raw)).toHaveLength(1);
  });
});

describe('parseSemgrepJsonOutput', () => {
  it('maps results into invariant failures', () => {
    const json = JSON.stringify({
      results: [
        {
          path: '/work/src/foo.ts',
          start: { line: 12, col: 5 },
          check_id: 'no-supabase-outside-data',
          extra: { message: 'Supabase calls only allowed in data/ layer' },
        },
      ],
    });
    const out = parseSemgrepJsonOutput(json);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'invariant',
      file: 'src/foo.ts',
      line: 12,
      column: 5,
    });
    expect(out[0]?.message).toContain('no-supabase-outside-data');
  });

  it('returns empty array on malformed JSON', () => {
    expect(parseSemgrepJsonOutput('not json')).toEqual([]);
  });
});

describe('parseGenericBuildOutput', () => {
  it('captures error lines', () => {
    const raw = `Building...\nerror: Cannot resolve module './missing'\nerror: Another issue here\n`;
    const out = parseGenericBuildOutput(raw);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]?.kind).toBe('build');
  });
});

describe('fallbackFailure', () => {
  it('builds a single-line summary when raw output present', () => {
    const f = fallbackFailure('test', '\n   Some failure here\n   trailing detail');
    expect(f).toMatchObject({ kind: 'test' });
    expect(f.message).toContain('Some failure here');
  });

  it('uses synthetic message when raw is empty', () => {
    const f = fallbackFailure('lint', '');
    expect(f.message).toContain('lint failed');
  });
});

describe('parsePhaseOutput dispatch', () => {
  it('routes typecheck → tsc parser', () => {
    const out = parsePhaseOutput('typecheck', `src/foo.ts(1,1): error TS1: x`);
    expect(out[0]?.kind).toBe('typecheck');
  });

  it('emits synthetic failure for empty input', () => {
    const out = parsePhaseOutput('test', '');
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('test failed with no output');
  });
});
