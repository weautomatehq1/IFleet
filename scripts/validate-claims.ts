/**
 * validate-claims — assert that markdown tables match the data files they cite.
 *
 * Motivated by PR #128, where a hand-written results table reported "9/10 passed"
 * but the JSON it claimed to summarize had `passedCount: 0`. This walker scans for
 * `<!-- claim:TYPE src="PATH" -->...<!-- /claim -->` blocks and validates each table
 * row against the cited data file through a per-claim-type registry.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaimRow {
  label: string;
  value: string;
  /** 1-indexed line number in the source file */
  line: number;
}

export interface ClaimBlock {
  type: string;
  src: string;
  rows: ClaimRow[];
  startLine: number;
  endLine: number;
  filePath: string;
}

export interface RowExpectation {
  /** Human-readable JSON path for error messages */
  jsonPath: string;
  /** Canonical expected representation */
  expected: string;
  /** Whether the found value matches; defaults to normalized-equality on `expected` */
  match?: (found: string) => boolean;
}

export interface ClaimTypeHandler {
  /** Canonical row labels we expect to see in a fully-specified table */
  expectedRowLabels: readonly string[];
  /** Resolve a row label to its expectation, or null if unknown */
  resolve(data: unknown, rowLabel: string): RowExpectation | null;
}

export type Finding =
  | { kind: 'mismatch'; block: ClaimBlock; row: ClaimRow; expectation: RowExpectation }
  | { kind: 'unknown-type'; block: ClaimBlock }
  | { kind: 'missing-source'; block: ClaimBlock }
  | { kind: 'invalid-source'; block: ClaimBlock; reason: string }
  | { kind: 'unknown-row'; block: ClaimBlock; row: ClaimRow }
  | { kind: 'missing-row'; block: ClaimBlock; expectedLabel: string };

// Severity tiers. `error` blocks merges; `warn` is informational.
const ERROR_KINDS: ReadonlySet<Finding['kind']> = new Set([
  'mismatch',
  'unknown-type',
  'missing-source',
  'invalid-source',
]);

// ─── Value normalization ────────────────────────────────────────────────────

/** Normalize a markdown cell for tolerant comparison. */
export function normalizeValue(raw: string): string {
  return raw
    .trim()
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Normalize a row label to a slug for keying. */
export function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function defaultMatch(expected: string): (found: string) => boolean {
  const target = normalizeValue(expected);
  return (found) => normalizeValue(found) === target;
}

// ─── Markdown parser ────────────────────────────────────────────────────────

const CLAIM_OPEN_RE = /<!--\s*claim:([\w-]+)\s+src="([^"]+)"\s*-->/;
const CLAIM_CLOSE_RE = /<!--\s*\/claim\s*-->/;

const FENCE_RE = /^\s{0,3}(```|~~~)/;

export function parseClaimBlocks(filePath: string, content: string): ClaimBlock[] {
  const lines = content.split('\n');
  const blocks: ClaimBlock[] = [];
  let i = 0;
  let insideFence = false;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      insideFence = !insideFence;
      i++;
      continue;
    }
    if (insideFence) {
      i++;
      continue;
    }
    const open = line.match(CLAIM_OPEN_RE);
    if (!open) {
      i++;
      continue;
    }
    const [, type, src] = open;
    if (type == null || src == null) {
      i++;
      continue;
    }
    const startLine = i + 1;
    let j = i + 1;
    let innerFence = false;
    while (j < lines.length) {
      const inner = lines[j] ?? '';
      if (FENCE_RE.test(inner)) innerFence = !innerFence;
      if (!innerFence && CLAIM_CLOSE_RE.test(inner)) break;
      j++;
    }
    if (j === lines.length) {
      // unclosed block — skip silently
      i = j;
      continue;
    }
    const inner = lines.slice(i + 1, j);
    const rows = extractTableRows(inner, startLine);
    blocks.push({ type, src, rows, startLine, endLine: j + 1, filePath });
    i = j + 1;
  }
  return blocks;
}

function extractTableRows(innerLines: string[], blockStartLine: number): ClaimRow[] {
  const rows: ClaimRow[] = [];
  let inTable = false;
  let sawSeparator = false;

  for (let k = 0; k < innerLines.length; k++) {
    const line = (innerLines[k] ?? '').trim();
    if (!line.startsWith('|')) {
      if (inTable) {
        inTable = false;
        sawSeparator = false;
      }
      continue;
    }
    // pipe row
    if (!inTable) {
      inTable = true;
      sawSeparator = false;
      continue; // header row
    }
    if (!sawSeparator) {
      // expect `| --- | --- |`
      if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line)) {
        sawSeparator = true;
      } else {
        // not a real table — bail
        inTable = false;
      }
      continue;
    }
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const label = cells[0] ?? '';
    const value = cells[1] ?? '';
    if (label === '') continue;
    rows.push({
      label,
      value,
      // blockStartLine corresponds to the opening claim line; inner index k starts at 0
      // so absolute line = blockStartLine + 1 (opening) + k. blockStartLine is already
      // 1-indexed for the opening comment, so the line of innerLines[k] is blockStartLine + k + 1.
      line: blockStartLine + k + 1,
    });
  }
  return rows;
}

// ─── Registry ──────────────────────────────────────────────────────────────

/**
 * Replay-results claim type.
 * Source: `.ifleet/eval/replay-results.json` and equivalents produced by `scripts/eval-replay.ts`.
 */
interface ReplayResultsShape {
  passedCount: number;
  totalCount: number;
  passRatePct: number;
  passingGate: number;
  dodGatePassed: boolean;
  disagreementRate: number | null;
  avgDurationMs: number;
  totalCostUsd: number;
  sandboxMode?: string;
  eventsEmitted?: number;
}

function assertReplayShape(data: unknown): asserts data is ReplayResultsShape {
  if (data == null || typeof data !== 'object') {
    throw new Error('replay-results: top-level value is not an object');
  }
  const d = data as Record<string, unknown>;
  const required = ['passedCount', 'totalCount', 'passRatePct', 'dodGatePassed', 'disagreementRate'] as const;
  for (const key of required) {
    if (!(key in d)) throw new Error(`replay-results: missing key "${key}"`);
  }
}

const replayResultsHandler: ClaimTypeHandler = {
  expectedRowLabels: [
    'Pass rate',
    'DoD gate',
    'disagreementRate',
    'Avg duration per run',
    'Total cost',
  ],
  resolve(data, rowLabel) {
    assertReplayShape(data);
    const key = normalizeLabel(rowLabel);

    if (key.startsWith('passrate')) {
      const expected = `${data.passedCount} / ${data.totalCount} (${data.passRatePct}%)`;
      // accept either "9 / 10", "9/10", "9 / 10 (90%)", etc.
      const passN = data.passedCount;
      const totalN = data.totalCount;
      const pct = data.passRatePct;
      return {
        jsonPath: 'passedCount / totalCount',
        expected,
        match(found) {
          const f = normalizeValue(found);
          if (!f.includes(String(passN))) return false;
          if (!f.includes(String(totalN))) return false;
          // percent is optional; if present must match
          const hasPct = /\d+(\.\d+)?%/.test(f);
          if (hasPct) {
            const m = f.match(/(\d+(\.\d+)?)%/);
            if (!m) return false;
            const foundPct = parseFloat(m[1] ?? '');
            return Math.abs(foundPct - pct) < 0.51; // tolerate rounding to nearest integer
          }
          return true;
        },
      };
    }
    if (key.startsWith('dodgate')) {
      const expected = data.dodGatePassed ? 'PASSED' : 'FAILED';
      return {
        jsonPath: 'dodGatePassed',
        expected,
        match(found) {
          const f = normalizeValue(found);
          return data.dodGatePassed
            ? (f.includes('passed') || f.includes('pass') || f.includes('✓') || f.includes('yes'))
            : (f.includes('failed') || f.includes('fail') || f.includes('✗') || f.includes('no'));
        },
      };
    }
    if (key.includes('disagreement')) {
      const r = data.disagreementRate;
      const expected = r == null ? 'null' : r.toFixed(3);
      return {
        jsonPath: 'disagreementRate',
        expected,
        match(found) {
          const f = normalizeValue(found);
          if (r == null) {
            return f.includes('null') || f === 'n/a' || f === '—' || f === '-';
          }
          const m = f.match(/(\d+\.\d+|\d+)/);
          if (!m) return false;
          const n = parseFloat(m[1] ?? '');
          return Math.abs(n - r) < 0.005;
        },
      };
    }
    if (key.includes('avgduration')) {
      const expected = `${data.avgDurationMs} ms`;
      return {
        jsonPath: 'avgDurationMs',
        expected,
        match(found) {
          const f = normalizeValue(found);
          const m = f.match(/(\d+(?:\.\d+)?)\s*(ms|s)?/);
          if (!m) return false;
          let n = parseFloat(m[1] ?? '');
          if (m[2] === 's') n *= 1000;
          // tolerate ±20% rounding (e.g. "~13 s" vs 2457 ms is clearly out of range)
          return Math.abs(n - data.avgDurationMs) / Math.max(data.avgDurationMs, 1) < 0.2;
        },
      };
    }
    if (key.includes('totalcost')) {
      const expected = `$${data.totalCostUsd.toFixed(2)}`;
      return {
        jsonPath: 'totalCostUsd',
        expected,
        match(found) {
          const f = normalizeValue(found);
          const m = f.match(/\$?\s*(\d+(?:\.\d+)?)/);
          if (!m) return false;
          const n = parseFloat(m[1] ?? '');
          return Math.abs(n - data.totalCostUsd) < 0.005;
        },
      };
    }
    if (key.includes('sandbox')) {
      const expected = data.sandboxMode ?? '';
      return {
        jsonPath: 'sandboxMode',
        expected,
        match: defaultMatch(expected),
      };
    }
    if (key.includes('eventsemitted')) {
      const expected = String(data.eventsEmitted ?? '');
      return {
        jsonPath: 'eventsEmitted',
        expected,
        match: defaultMatch(expected),
      };
    }
    return null;
  },
};

/**
 * Verifier-baseline claim type. Reserved for future use (e.g. disagreement-rate
 * baselines tracked alongside the eval set). Handlers can pick whichever fields
 * they want from the data file.
 */
const verifierBaselineHandler: ClaimTypeHandler = {
  expectedRowLabels: ['disagreementRate', 'falsePositiveRate'],
  resolve(data, rowLabel) {
    if (data == null || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const key = normalizeLabel(rowLabel);
    if (key.includes('disagreement')) {
      const v = d['disagreementRate'];
      if (typeof v !== 'number' && v !== null) return null;
      const expected = v == null ? 'null' : v.toFixed(3);
      return { jsonPath: 'disagreementRate', expected, match: defaultMatch(expected) };
    }
    if (key.includes('falsepositive')) {
      const v = d['falsePositiveRate'];
      if (typeof v !== 'number') return null;
      return {
        jsonPath: 'falsePositiveRate',
        expected: v.toFixed(3),
        match: defaultMatch(v.toFixed(3)),
      };
    }
    return null;
  },
};

const REGISTRY: Record<string, ClaimTypeHandler> = {
  'replay-results': replayResultsHandler,
  'verifier-baseline': verifierBaselineHandler,
};

export function registerClaimType(name: string, handler: ClaimTypeHandler): void {
  REGISTRY[name] = handler;
}

// ─── Validator ──────────────────────────────────────────────────────────────

export function validateBlock(block: ClaimBlock, repoRoot: string): Finding[] {
  const handler = REGISTRY[block.type];
  if (!handler) {
    return [{ kind: 'unknown-type', block }];
  }
  const srcPath = resolve(repoRoot, block.src);
  if (!existsSync(srcPath)) {
    return [{ kind: 'missing-source', block }];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch (err) {
    return [{ kind: 'invalid-source', block, reason: (err as Error).message }];
  }

  const findings: Finding[] = [];
  const coveredPaths = new Set<string>();

  for (const row of block.rows) {
    let expectation: RowExpectation | null;
    try {
      expectation = handler.resolve(data, row.label);
    } catch (err) {
      findings.push({ kind: 'invalid-source', block, reason: (err as Error).message });
      return findings;
    }
    if (!expectation) {
      findings.push({ kind: 'unknown-row', block, row });
      continue;
    }
    coveredPaths.add(expectation.jsonPath);
    const matcher = expectation.match ?? defaultMatch(expectation.expected);
    if (!matcher(row.value)) {
      findings.push({ kind: 'mismatch', block, row, expectation });
    }
  }

  // Missing-row coverage is keyed by jsonPath (canonical), not raw label, so
  // "DoD gate" and "DoD gate (≥ 8 / 10)" both count as covering `dodGatePassed`.
  for (const label of handler.expectedRowLabels) {
    let exp: RowExpectation | null;
    try {
      exp = handler.resolve(data, label);
    } catch {
      exp = null;
    }
    if (exp && !coveredPaths.has(exp.jsonPath)) {
      findings.push({ kind: 'missing-row', block, expectedLabel: label });
    }
  }

  return findings;
}

// ─── Markdown discovery ────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.omc',
  '.claude',
  '.husky',
]);

export function findMarkdownFiles(rootDirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of rootDirs) {
    if (!existsSync(dir)) continue;
    walk(dir, out);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
}

// ─── Reporter ──────────────────────────────────────────────────────────────

function reportFinding(f: Finding, repoRoot: string): string {
  const rel = relative(repoRoot, f.block.filePath);
  switch (f.kind) {
    case 'mismatch':
      return [
        `ERROR ${rel}:${f.row.line}`,
        `  claim:${f.block.type} src="${f.block.src}"`,
        `  row "${f.row.label}":`,
        `    expected (${f.expectation.jsonPath}): ${f.expectation.expected}`,
        `    found:                                ${f.row.value}`,
      ].join('\n');
    case 'unknown-type':
      return [
        `ERROR ${rel}:${f.block.startLine}`,
        `  unknown claim type "${f.block.type}". Register a handler in scripts/validate-claims.ts.`,
      ].join('\n');
    case 'missing-source':
      return [
        `ERROR ${rel}:${f.block.startLine}`,
        `  claim:${f.block.type} src="${f.block.src}" — source file not found at repo root`,
      ].join('\n');
    case 'invalid-source':
      return [
        `ERROR ${rel}:${f.block.startLine}`,
        `  claim:${f.block.type} src="${f.block.src}" — could not load: ${f.reason}`,
      ].join('\n');
    case 'unknown-row':
      return `WARN  ${rel}:${f.row.line} — row "${f.row.label}" has no handler for claim:${f.block.type}`;
    case 'missing-row':
      return `WARN  ${rel}:${f.block.startLine} — table missing expected row "${f.expectedLabel}" for claim:${f.block.type}`;
  }
}

function fixSuggestion(block: ClaimBlock, repoRoot: string): string | null {
  const handler = REGISTRY[block.type];
  if (!handler) return null;
  const srcPath = resolve(repoRoot, block.src);
  if (!existsSync(srcPath)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch {
    return null;
  }
  const lines = ['| Metric | Value |', '|---|---|'];
  for (const label of handler.expectedRowLabels) {
    let exp: RowExpectation | null;
    try {
      exp = handler.resolve(data, label);
    } catch {
      exp = null;
    }
    lines.push(`| ${label} | ${exp ? exp.expected : '?'} |`);
  }
  return lines.join('\n');
}

// ─── CLI ───────────────────────────────────────────────────────────────────

interface CliArgs {
  file?: string;
  fixSuggestions: boolean;
  changedOnly: boolean;
  base: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { fixSuggestions: false, changedOnly: false, base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--fix-suggestions') args.fixSuggestions = true;
    else if (a === '--changed-only') args.changedOnly = true;
    else if (a === '--base') args.base = argv[++i] ?? 'origin/main';
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return args;
}

const USAGE = `validate-claims — verify markdown claim blocks against cited data files.

Usage:
  validate-claims                       Scan repo (docs/, .ifleet/), exit 1 on error findings.
  validate-claims --file <path>         Check a single markdown file.
  validate-claims --fix-suggestions     Print proposed corrected tables for each block.
  validate-claims --changed-only        Only validate blocks in .md files changed vs. --base.
  validate-claims --base <ref>          Base ref for --changed-only (default: origin/main).

Claim block format:
  <!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->
  | Metric | Value |
  |---|---|
  | Pass rate | 9 / 10 (90%) |
  <!-- /claim -->
`;

function findRepoRoot(start: string): string {
  let cur = resolve(start);
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, '.git'))) return cur;
    cur = dirname(cur);
  }
  return start;
}

/**
 * Git ref-name charset. Conservative allowlist covering branch names, tags,
 * remotes (`origin/main`), and SHAs. Deliberately excludes shell metacharacters
 * (spaces, `;`, `|`, `$`, backticks, quotes) so a malicious `--base` value such
 * as `main; rm -rf .` is rejected before it ever reaches git.
 */
const BASE_REF_RE = /^[A-Za-z0-9._/-]+$/;

export function isValidBaseRef(base: string): boolean {
  return BASE_REF_RE.test(base);
}

export function changedMarkdownFiles(base: string, repoRoot: string): Set<string> {
  if (!isValidBaseRef(base)) {
    console.warn(`validate-claims: refusing invalid --base ref "${base}" (must match ${BASE_REF_RE})`);
    return new Set();
  }
  try {
    // argv-style: no shell is spawned, so even a ref that slipped the regex
    // could not inject a command. `${base}...HEAD` is a single argv token.
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', '*.md'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((rel) => resolve(repoRoot, rel)),
    );
  } catch (err) {
    console.warn(`validate-claims: could not compute changed files vs ${base}: ${(err as Error).message}`);
    return new Set();
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());

  const files = args.file
    ? [resolve(repoRoot, args.file)]
    : findMarkdownFiles([join(repoRoot, 'docs'), join(repoRoot, '.ifleet')]);

  const changedSet = args.changedOnly ? changedMarkdownFiles(args.base, repoRoot) : null;

  const blocks: ClaimBlock[] = [];
  for (const file of files) {
    if (changedSet && !changedSet.has(resolve(file))) continue;
    if (!existsSync(file)) {
      console.error(`validate-claims: file not found: ${file}`);
      return 2;
    }
    const content = readFileSync(file, 'utf8');
    blocks.push(...parseClaimBlocks(file, content));
  }

  if (args.fixSuggestions) {
    for (const b of blocks) {
      const suggestion = fixSuggestion(b, repoRoot);
      console.log(`# ${relative(repoRoot, b.filePath)}:${b.startLine}  claim:${b.type}`);
      console.log(suggestion ?? '(no handler or unreadable source)');
      console.log('');
    }
    return 0;
  }

  let errors = 0;
  let warns = 0;
  for (const block of blocks) {
    const findings = validateBlock(block, repoRoot);
    for (const f of findings) {
      console.log(reportFinding(f, repoRoot));
      if (ERROR_KINDS.has(f.kind)) errors++;
      else warns++;
    }
  }

  const total = blocks.length;
  console.log('');
  console.log(`validate-claims: ${total} block(s) scanned, ${errors} error(s), ${warns} warning(s).`);
  return errors > 0 ? 1 : 0;
}

const isCli = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isCli) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
