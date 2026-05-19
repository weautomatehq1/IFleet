/**
 * Invariant runner — executes Semgrep rules and ArchUnitTS-style assertions
 * declared in `.ifleet/invariants/<repo>/` against the editor's worktree.
 *
 * Semgrep:  reads `.ifleet/invariants/<repo>/semgrep.yml`, invokes
 *           `semgrep --config <path> --json <worktree>`, parses JSON results
 *           into {@link VerifierFailure}[] via {@link parseSemgrepJsonOutput}.
 *
 * Arch:     reads `.ifleet/invariants/<repo>/arch.ts`, requires it dynamically,
 *           expects a default-export async function returning a `Violation[]`.
 *           Violations are mapped to `kind: 'invariant'` failures with the
 *           file/line populated when available.
 *
 * Both are optional — a repo without either file passes the invariant phase
 * trivially. Both are best-effort: a malformed rules file or a thrown arch
 * assertion is reported as a single `invariant` failure with the parser/loader
 * error message; the rest of the verifier continues.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSemgrepJsonOutput } from './failure-parser.js';
import type { VerifierFailure } from './types.js';

export interface InvariantRunInput {
  /** Worktree being verified. */
  worktreePath: string;
  /**
   * Repo slug used to locate `.ifleet/invariants/<repoSlug>/`. Falls back to
   * a slug-of-the-path so a misconfigured repo still gets baseline invariants.
   */
  repoSlug: string;
  /** Root directory holding `.ifleet/invariants/` — typically the IFleet repo. */
  invariantsRoot?: string;
}

export interface InvariantConfig {
  semgrepBin?: string;
  /** Hard timeout for `semgrep --json`. Default 120 s. */
  semgrepTimeoutMs?: number;
  /** Override spawn for tests. */
  spawnFn?: typeof spawn;
}

export interface ArchViolation {
  message: string;
  file?: string;
  line?: number;
}

const DEFAULT_TIMEOUT = 120_000;

export class InvariantRunner {
  private readonly semgrepBin: string;
  private readonly semgrepTimeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(cfg: InvariantConfig = {}) {
    this.semgrepBin = cfg.semgrepBin ?? 'semgrep';
    this.semgrepTimeoutMs = cfg.semgrepTimeoutMs ?? DEFAULT_TIMEOUT;
    this.spawnFn = cfg.spawnFn ?? spawn;
  }

  /**
   * Run both kinds of invariants and return the aggregated failure list.
   * Empty array = clean run, no rules, or all rules passed.
   */
  async run(input: InvariantRunInput): Promise<VerifierFailure[]> {
    const root = input.invariantsRoot ?? process.cwd();
    const dir = join(root, '.ifleet', 'invariants', input.repoSlug);
    if (!existsSync(dir)) return [];

    const failures: VerifierFailure[] = [];
    const semgrepFailures = await this.runSemgrep(dir, input.worktreePath);
    failures.push(...semgrepFailures);
    const archFailures = await this.runArch(dir, input.worktreePath);
    failures.push(...archFailures);
    return failures;
  }

  private async runSemgrep(invariantsDir: string, worktreePath: string): Promise<VerifierFailure[]> {
    const rulesPath = join(invariantsDir, 'semgrep.yml');
    if (!existsSync(rulesPath)) return [];
    const result = await this.runCommand(
      this.semgrepBin,
      ['--config', rulesPath, '--json', '--quiet', '--no-git-ignore', worktreePath],
      { timeoutMs: this.semgrepTimeoutMs },
    );
    if (result.exitCode === null) {
      return [
        {
          kind: 'invariant',
          message: `semgrep crashed (${result.timedOut ? 'timeout' : 'spawn error'})`,
          rawOutput: result.output.slice(0, 4096),
        },
      ];
    }
    // Semgrep exit 0 = no findings, 1 = findings present, 2 = config error.
    if (result.exitCode === 2) {
      return [
        {
          kind: 'invariant',
          message: 'semgrep config error',
          rawOutput: result.output.slice(0, 4096),
        },
      ];
    }
    return parseSemgrepJsonOutput(result.output);
  }

  private async runArch(invariantsDir: string, worktreePath: string): Promise<VerifierFailure[]> {
    const archPath = join(invariantsDir, 'arch.ts');
    const archJsPath = join(invariantsDir, 'arch.js');
    const targetPath = existsSync(archPath) ? archPath : existsSync(archJsPath) ? archJsPath : null;
    if (!targetPath) return [];
    try {
      const mod = (await import(pathToFileURL(targetPath).href)) as { default?: unknown };
      const handler = mod.default;
      if (typeof handler !== 'function') {
        return [
          {
            kind: 'invariant',
            message: `${targetPath}: default export is not a function`,
          },
        ];
      }
      const result = (await handler({ worktreePath })) as ArchViolation[] | void;
      if (!result || !Array.isArray(result)) return [];
      return result.map((v) => {
        const failure: VerifierFailure = {
          kind: 'invariant',
          message: v.message,
        };
        if (v.file) failure.file = v.file;
        if (v.line !== undefined) failure.line = v.line;
        return failure;
      });
    } catch (err) {
      return [
        {
          kind: 'invariant',
          message: `arch.ts threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
  }

  private runCommand(
    cmd: string,
    args: string[],
    opts: { timeoutMs: number },
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      };
      const child = this.spawnFn(cmd, args, spawnOpts);
      const chunks: Buffer[] = [];
      const onData = (data: Buffer): void => {
        chunks.push(data);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          output: Buffer.concat(chunks).toString('utf8') + `\n[spawn error] ${err.message}`,
          timedOut,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8'), timedOut });
      });
    });
  }
}
