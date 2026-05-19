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
  path: string;   // the import specifier as written
  line: number;
}

function extractImports(filePath: string): ImportRef[] {
  const src = readFileSync(filePath, 'utf8');
  const refs: ImportRef[] = [];
  // Match static import/export ... from '...' and require('...')
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  const lines = src.split('\n');
  lines.forEach((line: string, idx: number) => {
    let m: RegExpExecArray | null;
    const lineRe = /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
    while ((m = lineRe.exec(line)) !== null) {
      refs.push({ path: m[1] as string, line: idx + 1 });
    }
    // require()
    const reqRe = /require\(['"]([^'"]+)['"]\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = reqRe.exec(line)) !== null) {
      refs.push({ path: rm[1] as string, line: idx + 1 });
    }
  });
  void re; // suppress unused-var warning — we use the per-line version above
  return refs;
}

// ── Rule runner ──────────────────────────────────────────────────────────────

interface RuleOptions {
  /** Absolute paths of files in scope for the "from" side. */
  fromFiles: string[];
  /** The import specifier must match this predicate to be a violation. */
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
  // Allowing the import would couple sprint logic to GitHub rate-limit handling.
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
  // Why: the pipeline (architect/editor/reviewer/verifier) must remain
  // Discord-agnostic so it can be driven by other interfaces (REST, eval
  // harness, CLI). Discord awareness leaking into pipeline logic couples the
  // two layers and makes the eval harness unreliable.
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
  // Why: importing test files in production code drags test-only setup,
  // mocks, and fixtures into the runtime bundle. It also creates a circular
  // dependency risk that obscures real module boundaries.
  {
    const testFiles = new Set(allTs.filter(f => f.endsWith('.test.ts')));
    const nonTestFiles = allTs.filter(f => !f.endsWith('.test.ts'));

    for (const file of nonTestFiles) {
      for (const ref of extractImports(file)) {
        // Resolve relative imports to absolute paths to detect test files
        if (ref.path.startsWith('.')) {
          const resolved =
            resolve(join(file, '..'), ref.path) + '.ts';
          if (testFiles.has(resolved)) {
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
