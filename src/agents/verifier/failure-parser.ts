/**
 * Failure parsers — turn raw stdout/stderr from each verifier phase into a
 * structured {@link VerifierFailure}[]. Drives the editor-retry feedback loop
 * (see retry-orchestrator.ts) and the canary disagreement-rate metric.
 *
 * Each parser is a pure function: input is the raw output string from one
 * phase, output is the failure list. Empty list means "no parseable failure
 * detected"; the caller decides whether that's actually success (exit 0) or
 * a parser miss (exit !=0 with empty failures → fallback to raw-output blob).
 *
 * Coverage matrix (deliberately narrow — these are the tools every IFleet
 * repo runs via pnpm scripts):
 *   - tsc           → src/foo.ts(12,5): error TS2304: Cannot find name 'X'.
 *   - eslint        → /abs/src/foo.ts: line 12, col 5, Error - msg (rule)
 *   - vitest        →  FAIL  src/foo.test.ts > suite > test
 *   - pnpm install  →  ERR_PNPM_*  | ELIFECYCLE
 *   - semgrep       →  src/foo.ts:12: rule-id - message
 *
 * NOT covered yet (logged as `kind: 'test'|'build'` with raw output only):
 *   - jest, mocha, ava — wait for first eval-set hit, then add
 *   - tsup/esbuild — usually surfaces via tsc, falls through cleanly
 */

import type { VerifierFailure, VerifierFailureKind } from './types.js';

const MAX_RAW_OUTPUT_BYTES = 4096;

/** Truncate raw output to the 4 kB cap documented on {@link VerifierFailure.rawOutput}. */
function clip(raw: string): string {
  if (raw.length <= MAX_RAW_OUTPUT_BYTES) return raw;
  return raw.slice(0, MAX_RAW_OUTPUT_BYTES) + '\n[truncated]';
}

/** Strip ANSI color codes so regex patterns don't have to model escape sequences. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * tsc emits lines like:
 *   `src/foo.ts(12,5): error TS2304: Cannot find name 'X'.`
 *   `src/foo.ts:12:5 - error TS2304: Cannot find name 'X'.` (vite/tsc --pretty=false alt)
 */
export function parseTscOutput(raw: string): VerifierFailure[] {
  const cleaned = stripAnsi(raw);
  const failures: VerifierFailure[] = [];
  const seen = new Set<string>();
  const parenRe = /^([^\s(][^\s()]*?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+?)$/gm;
  const colonRe = /^([^\s:][^\s:]*?):(\d+):(\d+)\s+-\s+error\s+TS\d+:\s+(.+?)$/gm;
  for (const re of [parenRe, colonRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const file = m[1]!;
      const line = Number(m[2]);
      const column = Number(m[3]);
      const message = m[4]!.trim();
      const key = `${file}:${line}:${column}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({
        kind: 'typecheck',
        file,
        line,
        column,
        message,
        rawOutput: clip(m[0]!),
      });
    }
  }
  return failures;
}

/**
 * eslint compact / stylish formatter — we match the stylish form because it's
 * the default and what `pnpm lint` prints. Stylish blocks look like:
 *
 *   /abs/path/src/foo.ts
 *     12:5  error  'X' is not defined  no-undef
 *     14:1  warning  Unexpected console.log  no-console
 */
export function parseEslintOutput(raw: string): VerifierFailure[] {
  const cleaned = stripAnsi(raw);
  const failures: VerifierFailure[] = [];
  const lines = cleaned.split('\n');
  let currentFile: string | undefined;
  const fileRe = /^(\/?[\w./\-_@]+\.(?:ts|tsx|js|jsx|mjs|cjs))$/;
  const issueRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w/-]+)\s*$/;
  for (const line of lines) {
    const fileMatch = fileRe.exec(line.trim());
    if (fileMatch) {
      currentFile = fileMatch[1]!;
      continue;
    }
    const m = issueRe.exec(line);
    if (m && currentFile) {
      const severity = m[3]!;
      if (severity !== 'error') continue;
      failures.push({
        kind: 'lint',
        file: stripCwd(currentFile),
        line: Number(m[1]),
        column: Number(m[2]),
        message: `${m[4]!.trim()} (${m[5]})`,
        rawOutput: clip(line.trim()),
      });
    }
  }
  return failures;
}

/**
 * vitest text reporter:
 *   ` FAIL  src/foo.test.ts > suite > expects something`
 *   `   AssertionError: expected 1 to equal 2`
 *   `      ❯ src/foo.test.ts:12:5`
 *
 * We capture the FAIL header (file + test name) and the location pointer so
 * the editor knows which test failed and where the failing assertion lives.
 */
export function parseVitestOutput(raw: string): VerifierFailure[] {
  const cleaned = stripAnsi(raw);
  const failures: VerifierFailure[] = [];
  const blocks = cleaned.split(/\n(?= FAIL |\bFAIL\b)/);
  for (const block of blocks) {
    const headerRe = /(?:^|\n)\s*FAIL\s+(.+?\.test\.(?:ts|tsx|js))\s*>\s*(.+?)$/m;
    const header = headerRe.exec(block);
    if (!header) continue;
    const file = header[1]!.trim();
    const testName = header[2]!.trim();
    const locRe = /❯\s+(.+?\.(?:ts|tsx|js)):(\d+):(\d+)/;
    const loc = locRe.exec(block);
    const assertion = /(?:AssertionError|Error):\s+(.+)/.exec(block);
    const message = assertion ? `${testName}: ${assertion[1]!.trim()}` : `${testName}: test failed`;
    const failure: VerifierFailure = {
      kind: 'test',
      file: loc?.[1] ?? file,
      message,
      rawOutput: clip(block.trim()),
    };
    if (loc) {
      failure.line = Number(loc[2]);
      failure.column = Number(loc[3]);
    }
    failures.push(failure);
  }
  return failures;
}

/**
 * pnpm install failures — pnpm writes `ERR_PNPM_*` for fatal errors and
 * `ELIFECYCLE` for lifecycle (postinstall) failures. Both go to verifier as
 * `install` failures — no file/line, just the error code + first message line.
 */
export function parsePnpmInstallOutput(raw: string): VerifierFailure[] {
  const cleaned = stripAnsi(raw);
  const failures: VerifierFailure[] = [];
  const errRe = /(ERR_PNPM_[A-Z0-9_]+)\s*([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = errRe.exec(cleaned)) !== null) {
    failures.push({
      kind: 'install',
      message: `${m[1]}: ${(m[2] ?? '').trim() || 'pnpm install failed'}`,
      rawOutput: clip(m[0]!),
    });
  }
  // Don't double-report ELIFECYCLE when an ERR_PNPM_* already matched —
  // pnpm prints both for the same root cause and the editor only needs one.
  if (failures.length === 0 && /\bELIFECYCLE\b/.test(cleaned)) {
    const lineRe = /\bELIFECYCLE\b[^\n]*/;
    const line = lineRe.exec(cleaned)?.[0] ?? 'ELIFECYCLE: pnpm step failed';
    failures.push({ kind: 'install', message: line.trim(), rawOutput: clip(line) });
  }
  return failures;
}

/**
 * semgrep JSON output (`--json`). When the runner can call semgrep with
 * `--json` we get `{ results: [{ path, start: {line, col}, check_id, extra: {message} }] }`.
 * Parsing the JSON form is far more reliable than scraping the text form.
 */
export function parseSemgrepJsonOutput(rawJson: string): VerifierFailure[] {
  try {
    const parsed = JSON.parse(rawJson) as {
      results?: Array<{
        path?: string;
        start?: { line?: number; col?: number };
        check_id?: string;
        extra?: { message?: string; severity?: string };
      }>;
    };
    const results = parsed.results ?? [];
    return results.map((r) => {
      const failure: VerifierFailure = {
        kind: 'invariant',
        message: `${r.check_id ?? 'semgrep-rule'}: ${r.extra?.message ?? 'invariant violated'}`,
        rawOutput: clip(JSON.stringify(r)),
      };
      if (r.path) failure.file = stripCwd(r.path);
      if (r.start?.line !== undefined) failure.line = r.start.line;
      if (r.start?.col !== undefined) failure.column = r.start.col;
      return failure;
    });
  } catch {
    return [];
  }
}

/** Generic build-script fallback (tsup/esbuild/etc.). Matches `error:` lines. */
export function parseGenericBuildOutput(raw: string): VerifierFailure[] {
  const cleaned = stripAnsi(raw);
  const failures: VerifierFailure[] = [];
  const re = /(?:^|\n)(?:.*?error[:\]]\s*)(.+?)(?=\n|$)/gi;
  let m: RegExpExecArray | null;
  let cap = 0;
  while ((m = re.exec(cleaned)) !== null && cap < 20) {
    const message = m[1]!.trim();
    if (!message || message.length < 4) continue;
    failures.push({ kind: 'build', message, rawOutput: clip(m[0]!) });
    cap++;
  }
  return failures;
}

function stripCwd(file: string): string {
  // Strip a /work/ prefix (the Docker mount path) so failure file paths are
  // relative to the repo root regardless of where verification ran.
  if (file.startsWith('/work/')) return file.slice('/work/'.length);
  if (file.startsWith('/work')) return file.slice('/work'.length);
  return file;
}

/**
 * Phase → parser dispatch. Phases that can't be parsed (or where the parser
 * found nothing in the raw output despite a non-zero exit) get a synthetic
 * failure with the raw output as `message` so the editor still sees feedback.
 */
export function parsePhaseOutput(
  kind: VerifierFailureKind,
  raw: string,
): VerifierFailure[] {
  if (!raw || raw.trim().length === 0) {
    return [{ kind, message: `${kind} failed with no output` }];
  }
  switch (kind) {
    case 'typecheck':
      return parseTscOutput(raw);
    case 'lint':
      return parseEslintOutput(raw);
    case 'test':
      return parseVitestOutput(raw);
    case 'install':
      return parsePnpmInstallOutput(raw);
    case 'invariant':
      return parseSemgrepJsonOutput(raw);
    case 'build':
      return parseGenericBuildOutput(raw);
  }
}

/**
 * Synthesize a single fallback failure when the phase failed (exit != 0) but
 * no structured failures were parsed — guarantees the retry loop always has
 * at least one piece of feedback to send back to the editor.
 */
export function fallbackFailure(
  kind: VerifierFailureKind,
  raw: string,
): VerifierFailure {
  const cleaned = stripAnsi(raw).trim();
  const firstLine = cleaned.split('\n').find((l) => l.trim().length > 0) ?? `${kind} failed`;
  return {
    kind,
    message: firstLine.slice(0, 200),
    rawOutput: clip(cleaned),
  };
}
