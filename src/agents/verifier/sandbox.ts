/**
 * Docker sandbox invocation — M1.W2 implementation.
 *
 * Contract: given a {@link VerifierRunInput}, return a {@link VerifierRunResult}
 * with parsed failures and per-phase reports. Implementation runs the editor's
 * SHA through pnpm install → build → typecheck → lint → test inside an
 * ephemeral Docker container. Falls back to in-worktree execution when the
 * Docker daemon is unreachable (banner: 'sandbox: unavailable').
 *
 * Phases run as separate `docker run` invocations against the worktree mount
 * so phase-level output is captured cleanly and a SIGKILL on one phase doesn't
 * poison the next. Container limits per ADR-0002: 4GB RAM, 10-min wall clock
 * per phase, no host network by default.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fallbackFailure,
  parsePhaseOutput,
  parseSemgrepJsonOutput,
} from './failure-parser.js';
import type {
  VerifierFailure,
  VerifierFailureKind,
  VerifierPhaseReport,
  VerifierRunInput,
  VerifierRunResult,
  VerifierStatus,
} from './types.js';
import { newVerifierRunId } from './types.js';

export interface SandboxRunner {
  run(input: VerifierRunInput): Promise<VerifierRunResult>;
}

export interface SandboxConfig {
  image?: string;
  timeoutMs?: number;
  memoryMb?: number;
  dockerBin?: string;
  pnpmBin?: string;
  now?: () => number;
  rawLogSink?: (runId: string, log: string) => Promise<string | undefined>;
  spawnFn?: typeof spawn;
  /** Directory containing per-repo env files. Defaults to `.ifleet/verify-env` in cwd. */
  envDir?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_IMAGE = 'ifleet-verifier:base';
const PHASE_ORDER: VerifierFailureKind[] = [
  'install',
  'build',
  'typecheck',
  'lint',
  'test',
];

const PHASE_TO_SCRIPT: Record<Exclude<VerifierFailureKind, 'install' | 'invariant'>, string> = {
  build: 'build',
  typecheck: 'typecheck',
  lint: 'lint',
  test: 'test',
};

interface PhaseRunOutcome {
  report: VerifierPhaseReport;
  failures: VerifierFailure[];
  rawOutput: string;
  timedOut?: boolean;
}

/**
 * Stub sandbox runner. Returns `passed` unconditionally so the editor.completed
 * → verifier.passed → PR-open contract can be tested end-to-end without Docker.
 */
export class StubSandboxRunner implements SandboxRunner {
  private readonly now: () => number;

  constructor(cfg: SandboxConfig = {}) {
    this.now = cfg.now ?? Date.now;
  }

  async run(input: VerifierRunInput): Promise<VerifierRunResult> {
    const startedAt = this.now();
    await Promise.resolve();
    const finishedAt = this.now();
    return {
      runId: newVerifierRunId(randomUUID()),
      status: 'passed',
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      attempt: input.attempt,
      failures: [],
      phases: [],
    };
  }
}

/** Real Docker sandbox runner. See module-level docstring for behavior. */
export class DockerSandboxRunner implements SandboxRunner {
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly memoryMb: number;
  private readonly dockerBin: string;
  private readonly pnpmBin: string;
  private readonly now: () => number;
  private readonly rawLogSink: SandboxConfig['rawLogSink'];
  private readonly spawnFn: typeof spawn;
  private readonly envDir: string;

  constructor(cfg: SandboxConfig = {}) {
    this.image = cfg.image ?? DEFAULT_IMAGE;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryMb = cfg.memoryMb ?? DEFAULT_MEMORY_MB;
    this.dockerBin = cfg.dockerBin ?? 'docker';
    this.pnpmBin = cfg.pnpmBin ?? 'pnpm';
    this.now = cfg.now ?? Date.now;
    this.rawLogSink = cfg.rawLogSink;
    this.spawnFn = cfg.spawnFn ?? spawn;
    this.envDir = cfg.envDir ?? join(process.cwd(), '.ifleet', 'verify-env');
  }

  async run(input: VerifierRunInput): Promise<VerifierRunResult> {
    const startedAt = this.now();
    const runId = newVerifierRunId(randomUUID());

    let worktreePath = input.worktreePath;
    let tempCloneDir: string | undefined;
    if (!worktreePath) {
      const cloned = await this.cloneFromSha(input.repoUrl, input.sha);
      if (!cloned.ok) {
        const finishedAt = this.now();
        return {
          runId,
          status: 'error',
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
          attempt: input.attempt,
          failures: [{ kind: 'install', message: cloned.error }],
          phases: [],
        };
      }
      worktreePath = cloned.path;
      tempCloneDir = cloned.path;
    }

    try {
      return await this.runInWorktree(input, runId, worktreePath, startedAt);
    } finally {
      if (tempCloneDir) {
        try {
          rmSync(tempCloneDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  private async cloneFromSha(
    repoUrl: string,
    sha: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    let tempDir: string;
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'ifleet-verifier-clone-'));
    } catch (err) {
      return { ok: false, error: `mkdtemp failed: ${(err as Error).message}` };
    }
    const cloneRes = await this.runCommand(
      'git',
      ['clone', '--quiet', repoUrl, tempDir],
      { timeoutMs: this.timeoutMs },
    );
    if (cloneRes.exitCode !== 0) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      return {
        ok: false,
        error: `git clone ${repoUrl} failed (exit ${cloneRes.exitCode}): ${cloneRes.output.slice(0, 500)}`,
      };
    }
    const checkoutRes = await this.runCommand(
      'git',
      ['-C', tempDir, 'checkout', '--quiet', sha],
      { timeoutMs: 60_000 },
    );
    if (checkoutRes.exitCode !== 0) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      return {
        ok: false,
        error: `git checkout ${sha} failed (exit ${checkoutRes.exitCode}): ${checkoutRes.output.slice(0, 500)}`,
      };
    }
    return { ok: true, path: tempDir };
  }

  private async runInWorktree(
    input: VerifierRunInput,
    runId: ReturnType<typeof newVerifierRunId>,
    worktreePath: string,
    startedAt: number,
  ): Promise<VerifierRunResult> {
    if (!existsSync(worktreePath)) {
      const finishedAt = this.now();
      return {
        runId,
        status: 'error',
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        attempt: input.attempt,
        failures: [{ kind: 'install', message: `worktree not found: ${worktreePath}` }],
        phases: [],
      };
    }

    const dockerOk = await this.probeDocker();
    if (!dockerOk && process.env['NODE_ENV'] === 'production' && !process.env['IFLEET_ALLOW_SANDBOX_FALLBACK']) {
      const finishedAt = this.now();
      return {
        runId,
        status: 'error',
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        attempt: input.attempt,
        failures: [{ kind: 'install', message: 'Docker daemon unreachable — sandbox fallback disabled in production (set IFLEET_ALLOW_SANDBOX_FALLBACK=1 to override)' }],
        phases: [],
      };
    }
    const useFallback = !dockerOk;
    const banner = useFallback
      ? 'sandbox: unavailable (Docker daemon unreachable, ran in-worktree)'
      : undefined;

    const repoId = repoIdFromUrl(input.repoUrl);
    const envFilePath = join(this.envDir, `${repoId}.env`);
    const hasEnvFile = existsSync(envFilePath);

    const pkg = readPackageJson(worktreePath);
    const plan = planPhases(pkg);

    const phaseReports: VerifierPhaseReport[] = [];
    const allFailures: VerifierFailure[] = [];
    const rawLogChunks: string[] = [];
    let timedOut = false;
    let hadHardFailure = false;

    for (const kind of PHASE_ORDER) {
      const planned = plan.phases.get(kind);
      if (!planned) continue;
      if (planned.skip) {
        phaseReports.push({
          kind,
          ok: true,
          exitCode: 0,
          durationMs: 0,
          skipped: true,
        });
        rawLogChunks.push(`=== ${kind} (skipped: ${planned.skipReason ?? 'not configured'}) ===\n`);
        continue;
      }

      let outcome = await this.runPhase(kind, worktreePath, useFallback, hasEnvFile ? envFilePath : undefined);
      phaseReports.push(outcome.report);
      rawLogChunks.push(
        `=== ${kind} (exit=${outcome.report.exitCode}, ${outcome.report.durationMs}ms) ===\n${outcome.rawOutput}\n`,
      );

      if (!outcome.report.ok) {
        if (
          kind === 'install' &&
          /network|ENOTFOUND|ECONNRESET|ERR_PNPM_FETCH/i.test(outcome.rawOutput)
        ) {
          await sleep(2000);
          outcome = await this.runPhase('install', worktreePath, useFallback, hasEnvFile ? envFilePath : undefined);
          phaseReports.pop();
          phaseReports.push(outcome.report);
          rawLogChunks.push(
            `=== install (retry, exit=${outcome.report.exitCode}, ${outcome.report.durationMs}ms) ===\n${outcome.rawOutput}\n`,
          );
        }
        if (!outcome.report.ok) {
          allFailures.push(...outcome.failures);
          if (isPhaseFatal(kind)) {
            hadHardFailure = true;
            break;
          }
        }
      }
      if (outcome.timedOut) {
        timedOut = true;
        break;
      }
    }

    const finishedAt = this.now();
    const fullLog = rawLogChunks.join('\n');
    const rawLogUrl = await this.uploadLog(runId, fullLog);

    const status = computeStatus({
      timedOut,
      hadHardFailure,
      allFailures,
      planPartial: plan.partial,
    });

    const result: VerifierRunResult = {
      runId,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      attempt: input.attempt,
      failures: allFailures,
      phases: phaseReports,
    };
    if (rawLogUrl) result.rawLogUrl = rawLogUrl;
    const bannerParts: string[] = [];
    if (banner) bannerParts.push(banner);
    if (plan.partial) bannerParts.push('verified: partial (no test script)');
    if (!hasEnvFile && !useFallback) bannerParts.push('verify-env: not configured');
    if (bannerParts.length > 0) result.banner = bannerParts.join(' | ');
    return result;
  }

  private async probeDocker(): Promise<boolean> {
    try {
      const result = await this.runCommand(this.dockerBin, ['info'], { timeoutMs: 5_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async runPhase(
    kind: VerifierFailureKind,
    worktreePath: string,
    useFallback: boolean,
    envFilePath?: string,
  ): Promise<PhaseRunOutcome> {
    const startedAt = this.now();
    const argv = buildPhaseArgv(kind);
    const command = useFallback ? this.pnpmBin : this.dockerBin;
    const args = useFallback ? argv : buildDockerArgs(this.image, worktreePath, this.memoryMb, argv, envFilePath);
    const result = await this.runCommand(command, args, {
      ...(useFallback ? { cwd: worktreePath } : {}),
      timeoutMs: this.timeoutMs,
    });
    const finishedAt = this.now();
    const ok = result.exitCode === 0;
    const failures = ok ? [] : parsePhaseOutput(kind, result.output);
    if (!ok && failures.length === 0) {
      failures.push(fallbackFailure(kind, result.output));
    }
    const report: VerifierPhaseReport = {
      kind,
      ok,
      exitCode: result.exitCode,
      durationMs: finishedAt - startedAt,
    };
    const outcome: PhaseRunOutcome = {
      report,
      failures,
      rawOutput: result.output,
    };
    if (result.timedOut) outcome.timedOut = true;
    return outcome;
  }

  private async uploadLog(runId: string, log: string): Promise<string | undefined> {
    if (!this.rawLogSink) {
      try {
        const dir = mkdtempSync(join(tmpdir(), `ifleet-verifier-${runId}-`));
        const path = join(dir, 'verifier.log');
        writeFileSync(path, log);
        return `file://${path}`;
      } catch {
        return undefined;
      }
    }
    try {
      return await this.rawLogSink(runId, log);
    } catch {
      return undefined;
    }
  }

  private runCommand(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      };
      if (opts.cwd) spawnOpts.cwd = opts.cwd;
      const child = this.spawnFn(cmd, args, spawnOpts);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const cap = 1_000_000;
      let truncated = false;
      const onData = (data: Buffer): void => {
        if (truncated) return;
        if (totalBytes + data.length > cap) {
          chunks.push(data.subarray(0, cap - totalBytes));
          totalBytes = cap;
          truncated = true;
          return;
        }
        chunks.push(data);
        totalBytes += data.length;
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
        let output = Buffer.concat(chunks).toString('utf8');
        if (truncated) output += '\n[output truncated]';
        if (timedOut) output += `\n[killed after ${opts.timeoutMs}ms]`;
        resolve({ exitCode: code, output, timedOut });
      });
    });
  }
}

interface PackageJsonScripts {
  scripts: Record<string, string>;
}

function readPackageJson(worktreePath: string): PackageJsonScripts {
  const path = join(worktreePath, 'package.json');
  if (!existsSync(path)) return { scripts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> };
    return { scripts: parsed.scripts ?? {} };
  } catch {
    return { scripts: {} };
  }
}

interface PhasePlanEntry {
  skip: boolean;
  skipReason?: string;
}

interface PhasePlan {
  phases: Map<VerifierFailureKind, PhasePlanEntry>;
  partial: boolean;
}

function planPhases(pkg: PackageJsonScripts): PhasePlan {
  const phases = new Map<VerifierFailureKind, PhasePlanEntry>();
  let partial = false;
  for (const kind of PHASE_ORDER) {
    if (kind === 'install') {
      phases.set(kind, { skip: false });
      continue;
    }
    const script = PHASE_TO_SCRIPT[kind as Exclude<VerifierFailureKind, 'install' | 'invariant'>];
    if (!pkg.scripts[script]) {
      phases.set(kind, { skip: true, skipReason: `no \`${script}\` script` });
      if (kind === 'test') partial = true;
      continue;
    }
    phases.set(kind, { skip: false });
  }
  return { phases, partial };
}

function buildPhaseArgv(kind: VerifierFailureKind): string[] {
  switch (kind) {
    case 'install':
      return ['install', '--frozen-lockfile', '--prefer-offline', '--store-dir', '/root/.pnpm-store'];
    case 'build':
    case 'typecheck':
    case 'lint':
    case 'test':
      return ['run', PHASE_TO_SCRIPT[kind]];
    case 'invariant':
      return ['--version'];
  }
}

function buildDockerArgs(
  image: string,
  worktreePath: string,
  memoryMb: number,
  innerArgv: string[],
  envFilePath?: string,
): string[] {
  const args = [
    'run',
    '--rm',
    '--memory',
    `${memoryMb}m`,
    '--network',
    'bridge',
    '--user',
    'root',
  ];
  if (envFilePath) {
    args.push('--env-file', envFilePath);
  }
  args.push(
    '-v',
    `${worktreePath}:/work`,
    '-w',
    '/work',
    image,
    'pnpm',
    ...innerArgv,
  );
  return args;
}

/** Derive a filesystem-safe repo identifier from a GitHub URL.
 * e.g. https://github.com/weautomatehq1/IFleet → weautomatehq1_IFleet */
function repoIdFromUrl(repoUrl: string): string {
  const match = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(repoUrl);
  const raw = match?.[1] != null ? match[1].replace('/', '_') : repoUrl;
  // Restrict to safe filename chars to prevent path traversal
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function isPhaseFatal(kind: VerifierFailureKind): boolean {
  return kind !== 'lint';
}

function computeStatus(args: {
  timedOut: boolean;
  hadHardFailure: boolean;
  allFailures: VerifierFailure[];
  planPartial: boolean;
}): VerifierStatus {
  if (args.timedOut) return 'timeout';
  if (args.hadHardFailure || args.allFailures.length > 0) {
    if (args.allFailures.every((f) => f.kind === 'install')) return 'error';
    return 'failed';
  }
  if (args.planPartial) return 'partial';
  return 'passed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { parseSemgrepJsonOutput };

export function discardRawLog(rawLogUrl: string | undefined): void {
  if (!rawLogUrl?.startsWith('file://')) return;
  const path = rawLogUrl.slice('file://'.length);
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

export const sandboxDefaults = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  memoryMb: DEFAULT_MEMORY_MB,
  image: DEFAULT_IMAGE,
});
