/**
 * ArchUnitTS-style dependency assertions for weautomatehq1/IFleet.
 *
 * No external deps — uses only Node fs/path so it compiles and runs without
 * the archunit package installed. The VerifierAgent (M1.W4) runs this via
 * `npx tsx .ifleet/invariants/weautomatehq1_IFleet/arch.ts` from the repo root.
 *
 * Exit 0 = all assertions pass.
 * Exit 1 = one or more violations found (lines prefixed VIOLATION: for the parser).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

interface Violation {
  rule: string;
  file: string;
  importPath: string;
  line: number;
}

// ── File walker ──────────────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && entry !== 'node_modules' && entry !== 'dist') {
      results.push(...walkTs(full));
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ── Import extractor ─────────────────────────────────────────────────────────

interface ImportRef {
  path: string;
  line: number;
}

/** Returns a function that maps a character index to its 1-based line number. */
function makeLineMapper(src: string): (idx: number) => number {
  const newlines: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') newlines.push(i);
  }
  return (idx: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((newlines[mid] ?? -1) < idx) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/**
 * Extracts all import specifiers from a TypeScript file, including multiline
 * imports. Works on full file content rather than line-by-line so that imports
 * like `import {\n  foo\n} from '../queue'` are not missed.
 */
function extractImports(filePath: string): ImportRef[] {
  const src = readFileSync(filePath, 'utf8');
  const lineOf = makeLineMapper(src);
  const refs: ImportRef[] = [];
  const seen = new Set<string>(); // dedupe by "path@line"

  function add(path: string, idx: number): void {
    const key = `${path}@${idx}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ path, line: lineOf(idx) });
    }
  }

  // from-style: import ... from '...', export ... from '...'
  // [\s\S]*? is lazy and stops at the shortest match so it doesn't span
  // across unrelated statements. \bfrom\b with word boundary avoids matching
  // identifiers like `getSomethingFrom`.
  const fromRe = /\b(?:import|export)\b[\s\S]*?\bfrom\b\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    add(m[1] as string, m.index);
  }

  // side-effect: import '...' (no bindings)
  const sideRe = /\bimport\b\s+['"]([^'"]+)['"]/gm;
  while ((m = sideRe.exec(src)) !== null) {
    add(m[1] as string, m.index);
  }

  // require('...')
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  while ((m = reqRe.exec(src)) !== null) {
    add(m[1] as string, m.index);
  }

  return refs;
}

// ── Rule runner ──────────────────────────────────────────────────────────────

interface RuleOptions {
  fromFiles: string[];
  importMatches: (spec: string) => boolean;
  ruleName: string;
  repoRoot: string;
}

function checkRule(opts: RuleOptions): Violation[] {
  const violations: Violation[] = [];
  for (const file of opts.fromFiles) {
    for (const ref of extractImports(file)) {
      if (opts.importMatches(ref.path)) {
        violations.push({
          rule: opts.ruleName,
          file: relative(opts.repoRoot, file),
          importPath: ref.path,
          line: ref.line,
        });
      }
    }
  }
  return violations;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const repoRoot = resolve(new URL('../../..', import.meta.url).pathname);
  const srcDir = join(repoRoot, 'src');
  const allTs = walkTs(srcDir);

  const violations: Violation[] = [];

  // ── Assertion 1 ──────────────────────────────────────────────────────────
  // src/orchestrator/sprint.ts must NOT import from src/queue/
  //
  // Why: SprintManager emits events; it must never call the queue bridge
  // directly. The queue subscribes TO SprintManager events — not the reverse.
  {
    const sprintFile = join(srcDir, 'orchestrator', 'sprint.ts');
    violations.push(
      ...checkRule({
        ruleName: 'sprint-no-queue-import',
        fromFiles: allTs.filter(f => f === sprintFile),
        importMatches: spec =>
          spec.includes('/queue/') || spec.startsWith('../queue') || spec === '../queue',
        repoRoot,
      })
    );
  }

  // ── Assertion 2 ──────────────────────────────────────────────────────────
  // src/pipeline/** must NOT import from src/discord/**
  //
  // Why: the pipeline must remain Discord-agnostic so it can be driven by the
  // eval harness, REST interface, or CLI. Discord awareness in pipeline logic
  // couples two layers that should be independent.
  {
    const pipelineFiles = allTs.filter(f =>
      f.startsWith(join(srcDir, 'pipeline') + '/')
    );
    violations.push(
      ...checkRule({
        ruleName: 'pipeline-no-discord-import',
        fromFiles: pipelineFiles,
        importMatches: spec =>
          spec.includes('/discord/') || spec.startsWith('../discord') || spec === '../discord',
        repoRoot,
      })
    );
  }

  // ── Assertion 3 ──────────────────────────────────────────────────────────
  // Test files (*.test.ts) must NOT be imported by non-test source code.
  //
  // Why: importing test files drags test-only setup, mocks, and fixtures into
  // the runtime bundle and creates circular dependency risk.
  {
    const testFiles = new Set(allTs.filter(f => f.endsWith('.test.ts')));
    const nonTestFiles = allTs.filter(f => !f.endsWith('.test.ts'));

    for (const file of nonTestFiles) {
      for (const ref of extractImports(file)) {
        if (!ref.path.startsWith('.')) continue;
        const base = resolve(join(file, '..'), ref.path);
        // Try the common resolution candidates: bare path, .ts, /index.ts
        const candidates = [base, base + '.ts', join(base, 'index.ts')];
        if (candidates.some(c => testFiles.has(c))) {
          violations.push({
            rule: 'no-test-imports-in-src',
            file: relative(repoRoot, file),
            importPath: ref.path,
            line: ref.line,
          });
        }
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────

  if (violations.length === 0) {
    console.log('arch: all assertions passed');
    process.exit(0);
  }

  for (const v of violations) {
    // VIOLATION: prefix is parsed by src/agents/verifier/invariants.ts
    console.error(
      `VIOLATION: [${v.rule}] ${v.file}:${v.line} imports "${v.importPath}"`
    );
  }
  process.exit(1);
}

main();
