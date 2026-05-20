#!/usr/bin/env node
/**
 * M1 DoD eval replay — runs 10 historical IFleet PRs through the verifier
 * and records the real disagreementRate().
 *
 * Sandbox modes:
 *   default              — in-worktree (pnpm runs on host, no Docker)
 *   IFLEET_REAL_SANDBOX=1 — Docker mode: runs ifleet-verifier:base container
 *                           per task. Docker daemon must be running and the
 *                           image must be built first:
 *                             docker build -f scripts/verifier-image/Dockerfile.base \
 *                               -t ifleet-verifier:base scripts/verifier-image/
 *
 * Results are written to:
 *   default mode:  .ifleet/eval/replay-results.json         (in-worktree baseline)
 *   docker mode:   .ifleet/eval/replay-results-docker.json  (Docker isolation check)
 *
 * Usage:
 *   node --import tsx scripts/eval-replay.ts
 *   IFLEET_REAL_SANDBOX=1 node --import tsx scripts/eval-replay.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---- Sandbox mode selection ----
const USE_DOCKER = process.env['IFLEET_REAL_SANDBOX'] === '1';
const DOCKER_IMAGE = process.env['IFLEET_DOCKER_IMAGE'] ?? 'ifleet-verifier:base';

/**
 * Returns a temp base path that is bind-mountable inside the Docker container.
 * On macOS with Colima (virtiofs), only /Users is auto-mounted — /tmp and
 * /var/folders are not. When Docker mode is active, we use a subdirectory of
 * the user's home rather than the OS tmpdir so mounts work correctly.
 */
function evalTmpBase(dockerMode: boolean): string {
  if (dockerMode) {
    const base = join(homedir(), '.ifleet-eval-tmp');
    mkdirSync(base, { recursive: true });
    return base;
  }
  return tmpdir();
}
import { StateStore } from '../src/orchestrator/store.js';
import { VerifierStoreBridge } from '../src/agents/verifier/store-bridge.js';
import { newVerifierRunId } from '../src/agents/verifier/types.js';
import type { VerifierFailure, VerifierStatus } from '../src/agents/verifier/types.js';
import type { SprintId, SprintRecord, TaskId } from '../src/orchestrator/types.js';

// ---- Eval configuration ----

const SPRINT_ID = 'eval-replay-m1' as SprintId;
const REPO_URL = 'https://github.com/weautomatehq1/IFleet.git';
const PHASE_TIMEOUT_MS = 120_000; // 2 min per phase

interface EvalTask {
  id: string;
  prNumber: number;
  sha: string;
  title: string;
}

const EVAL_TASKS: EvalTask[] = [
  { id: 'ifleet-IF-109', prNumber: 112, sha: 'd1c7460e1ce8e9bb12de78c1ba4949aded0774c9', title: 'feat(observability): route haiku-gate-passed through structured event sink' },
  { id: 'ifleet-IF-107', prNumber: 110, sha: '4b16737a3f5209b8f617e579f5b73ecbcf1b43c3', title: 'fix(mcp,classifier): wire MCP submitSprint to classifier SprintMode via label' },
  { id: 'ifleet-IF-098', prNumber: 105, sha: 'fa4038d56158c555c856118ce21bc8bca73f0331', title: 'chore: brief library + dead-code audit + post-merge lint' },
  { id: 'ifleet-IF-076', prNumber: 101, sha: 'a398a2869d14ef16e84a5a2fc19e95513aa75dbf', title: 'feat(pipeline): doctor extension — fingerprints, Haiku cost-split' },
  { id: 'ifleet-IF-075', prNumber: 104, sha: '7ad66f208e441779d309013ca4a53fe3d89586c3', title: 'feat(classifier): sprint mode routing + Haiku auto-routing' },
  { id: 'ifleet-IF-071', prNumber: 102, sha: 'b49ac73fb4531bf430a6fe519b2f7039d795350f', title: 'feat(pipeline): per-repo learnings + deep-interview phase' },
  { id: 'ifleet-IF-044', prNumber:  47, sha: 'e8f64b2e5d8da3644d33a08cd802ca1151b5315e', title: 'feat(classifier): reviewer >= architect invariant + complexity gate' },
  { id: 'ifleet-IF-029', prNumber:  31, sha: 'aa1008b25a01a4fc44d8df6debcdbe760d9a007d', title: 'feat(orchestrator): include durationMs in sprint.completed' },
  { id: 'ifleet-IF-020', prNumber:  24, sha: '56ba3a0d10fe55a3a72dc7262fd2522a1abbc9e7', title: 'feat(classifier): build brief → routing decision module' },
  { id: 'ifleet-IF-016', prNumber:  18, sha: '7bd6c17a089cd1ec5bbc3afe2dc2012b1d9450e9', title: 'fix(scripts): derive branch name from issue title in run-smoke' },
];

// ---- Docker probe ----

function probeDocker(): boolean {
  const r = spawnSync('docker', ['info'], { timeout: 5_000, encoding: 'utf8' });
  return r.status === 0;
}

// ---- Docker full-suite runner (one container per task) ----

interface DockerRunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  phases: PhaseResult[];
}

/**
 * Runs ifleet-verifier:base's entrypoint against a worktree.
 * The entrypoint prints structured "=== PHASE: <name> ===" headers so we can
 * split the output into per-phase chunks for reporting.
 */
function runDockerVerifier(worktreePath: string): DockerRunResult {
  const start = Date.now();

  // Patch pnpm-workspace.yaml only when it already exists (older SHAs).
  // Do NOT create the file from scratch — pnpm@9 errors with "packages field
  // missing or empty" when pnpm-workspace.yaml is present but has no `packages`
  // key. Historical SHAs without the file use package.json#pnpm for native
  // build config, which pnpm@9 reads without issue.
  const wsYamlPath = join(worktreePath, 'pnpm-workspace.yaml');
  if (existsSync(wsYamlPath)) {
    const wsContent = readFileSync(wsYamlPath, 'utf8');
    if (!wsContent.includes('better-sqlite3')) {
      writeFileSync(wsYamlPath, wsContent.trimEnd() + '\nonlyBuiltDependencies:\n  - better-sqlite3\n');
    }
  }

  const dockerArgs = [
    'run',
    '--rm',
    '--memory', '4096m',
    '--network', 'bridge',
    '-v', `${worktreePath}:/work`,
    '-w', '/work',
    '-e', 'VERIFIER_FROZEN=0', // older SHAs lack a current lockfile
    DOCKER_IMAGE,
  ];

  const r = spawnSync('docker', dockerArgs, {
    timeout: PHASE_TIMEOUT_MS * 5, // full suite timeout (5 phases × 2 min each)
    encoding: 'utf8',
  });
  const durationMs = Date.now() - start;
  const rawOutput = ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 20_000);
  const phases = parseDockerOutput(rawOutput, r.status);

  return {
    ok: r.status === 0,
    exitCode: r.status,
    output: rawOutput,
    durationMs,
    phases,
  };
}

/**
 * Splits entrypoint stdout by "=== PHASE: <name> ===" headers and derives
 * per-phase ok/skip/exitCode information from the phase content.
 */
function parseDockerOutput(output: string, containerExitCode: number | null): PhaseResult[] {
  const PHASE_ORDER = ['install', 'build', 'typecheck', 'lint', 'test'];
  const results: PhaseResult[] = [];

  // Split by phase headers
  const segments = output.split(/=== PHASE: (\w+) ===/);
  // segments: ['preamble', 'install', 'install output', 'build', 'build output', ...]

  const phaseOutputs = new Map<string, string>();
  for (let i = 1; i < segments.length; i += 2) {
    const phaseName = segments[i]!.toLowerCase();
    const phaseContent = segments[i + 1] ?? '';
    phaseOutputs.set(phaseName, phaseContent);
  }

  // Determine which phase caused a non-zero exit (last phase in output is the failing one)
  const seenPhases = [...phaseOutputs.keys()];
  const failingPhase = containerExitCode !== 0 ? seenPhases[seenPhases.length - 1] : null;

  for (const phase of PHASE_ORDER) {
    const content = phaseOutputs.get(phase);
    if (!content) {
      // Phase not reached (earlier phase failed fatally)
      continue;
    }

    const skipped = /^SKIP:/.test(content.trim());
    const ok = skipped
      ? true
      : phase !== failingPhase
        ? true
        : containerExitCode === 0;

    results.push({
      phase,
      ok,
      durationMs: 0, // not tracked per-phase in single-container mode
      skipped,
      exitCode: skipped ? 0 : phase === failingPhase ? containerExitCode : 0,
      output: content.slice(0, 2000),
    });
  }

  return results;
}

// ---- In-worktree phase runner ----

interface PhaseResult {
  phase: string;
  ok: boolean;
  durationMs: number;
  skipped: boolean;
  exitCode: number | null;
  output: string;
}

function runPhase(phase: string, worktreePath: string): PhaseResult {
  const start = Date.now();
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(worktreePath, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
    } catch {
      return { scripts: {} };
    }
  })();

  // Map phase → pnpm script name
  const scriptMap: Record<string, string> = {
    install: '',
    build: 'build',
    typecheck: 'typecheck',
    lint: 'lint',
    test: 'test',
  };

  if (phase === 'install') {
    // Patch pnpm-workspace.yaml so older SHAs (pre-PR #115) allow better-sqlite3 build scripts.
    // Without this, pnpm v10+ skips native postinstall and bindings are never compiled.
    const wsYamlPath = join(worktreePath, 'pnpm-workspace.yaml');
    const wsContent = existsSync(wsYamlPath) ? readFileSync(wsYamlPath, 'utf8') : '';
    if (!wsContent.includes('better-sqlite3')) {
      const patch = wsContent
        ? wsContent.trimEnd() + '\nonlyBuiltDependencies:\n  - better-sqlite3\n'
        : 'onlyBuiltDependencies:\n  - better-sqlite3\n';
      writeFileSync(wsYamlPath, patch);
    }

    const r = spawnSync('pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline'], {
      cwd: worktreePath,
      timeout: PHASE_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const durationMs = Date.now() - start;
    const output = ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 4000);
    return { phase, ok: r.status === 0, durationMs, skipped: false, exitCode: r.status, output };
  }

  const scriptName = scriptMap[phase];
  if (!scriptName || !pkg.scripts?.[scriptName]) {
    return { phase, ok: true, durationMs: 0, skipped: true, exitCode: 0, output: `no ${scriptName} script` };
  }

  const args = phase === 'test' ? ['run', scriptName, '--', '--run'] : ['run', scriptName];
  const r = spawnSync('pnpm', args, {
    cwd: worktreePath,
    timeout: PHASE_TIMEOUT_MS,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const durationMs = Date.now() - start;
  const output = ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 4000);
  return { phase, ok: r.status === 0, durationMs, skipped: false, exitCode: r.status, output };
}

// ---- Result types ----

interface TaskResult {
  id: string;
  prNumber: number;
  sha: string;
  title: string;
  status: VerifierStatus;
  durationMs: number;
  failuresCount: number;
  phases: PhaseResult[];
  error?: string;
}

// ---- Main ----

async function main(): Promise<void> {
  console.log('=== M1 DoD Eval Replay ===\n');

  // Sandbox mode selection — explicit log line for unambiguous output
  let sandboxMode: 'docker' | 'in-worktree fallback';
  if (USE_DOCKER) {
    const dockerOk = probeDocker();
    if (!dockerOk) {
      console.error('ERROR: IFLEET_REAL_SANDBOX=1 but Docker daemon is unreachable.');
      console.error('       Start Docker and ensure ifleet-verifier:base is built:');
      console.error(`         docker build -f scripts/verifier-image/Dockerfile.base \\`);
      console.error(`           -t ifleet-verifier:base scripts/verifier-image/`);
      process.exit(1);
    }
    sandboxMode = 'docker';
  } else {
    sandboxMode = 'in-worktree fallback';
  }
  console.log(`using sandbox: ${sandboxMode}`);
  if (sandboxMode === 'docker') {
    console.log(`docker image:  ${DOCKER_IMAGE}`);
  }
  console.log('');

  // Results file — Docker mode gets its own file to preserve in-worktree baseline
  const resultsFileName = sandboxMode === 'docker'
    ? 'replay-results-docker.json'
    : 'replay-results.json';
  const resultsPath = join(process.cwd(), '.ifleet/eval', resultsFileName);

  // Create a temp StateStore for this eval session
  const dbPath = join(tmpdir(), `eval-replay-${Date.now()}.db`);
  const store = new StateStore(dbPath);
  const bridge = new VerifierStoreBridge(store);

  // Seed sprint + task rows to satisfy FK constraints on verifier_runs
  const now = Date.now();
  const seedSprint: SprintRecord = {
    id: SPRINT_ID,
    mode: 'normal',
    goal: 'M1 DoD eval replay — 10 historical PRs',
    tasks: EVAL_TASKS.map((t) => t.id as TaskId),
    state: { kind: 'queued' },
    createdAt: now,
    updatedAt: now,
  };
  store.saveSprint(seedSprint);

  // Clone IFleet into a temp base dir.
  // In Docker mode we use ~/.ifleet-eval-tmp/ so paths are under /Users
  // (Colima virtiofs only auto-mounts /Users, not /tmp or /var/folders).
  const tmpBase = evalTmpBase(sandboxMode === 'docker');
  const baseCloneDir = mkdtempSync(join(tmpBase, 'ifleet-eval-base-'));
  console.log(`Cloning ${REPO_URL} → ${baseCloneDir} ...`);
  const cloneResult = spawnSync('git', ['clone', '--quiet', REPO_URL, baseCloneDir], {
    timeout: 300_000,
    encoding: 'utf8',
  });
  if (cloneResult.status !== 0) {
    console.error('Clone failed:', cloneResult.stderr);
    process.exit(1);
  }
  console.log('Clone complete.\n');

  const results: TaskResult[] = [];

  for (let i = 0; i < EVAL_TASKS.length; i++) {
    const task = EVAL_TASKS[i]!;
    const idx = `[${i + 1}/10]`;
    console.log(`${idx} ${task.id} — PR #${task.prNumber} — ${task.title.slice(0, 55)}`);

    const worktreeDir = join(tmpBase, `ifleet-eval-${task.id}`);
    if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true });

    // Add worktree at the merge SHA
    const wtResult = spawnSync('git', ['worktree', 'add', '--detach', worktreeDir, task.sha], {
      cwd: baseCloneDir,
      timeout: 30_000,
      encoding: 'utf8',
    });
    if (wtResult.status !== 0) {
      const errMsg = `worktree add failed: ${wtResult.stderr?.slice(0, 200)}`;
      console.error(`  ERROR: ${errMsg}`);
      results.push({ id: task.id, prNumber: task.prNumber, sha: task.sha, title: task.title, status: 'error', durationMs: 0, failuresCount: 1, phases: [], error: errMsg });
      continue;
    }

    const taskStart = Date.now();
    let phaseResults: PhaseResult[] = [];
    const failures: VerifierFailure[] = [];
    let finalStatus: VerifierStatus = 'passed';

    if (sandboxMode === 'docker') {
      // ---- Docker mode: single container run via entrypoint ----
      process.stdout.write(`  [docker] running ifleet-verifier:base ...\n`);
      const dockerResult = runDockerVerifier(worktreeDir);
      phaseResults = dockerResult.phases;

      if (!dockerResult.ok) {
        finalStatus = 'failed';
        // Find the first non-ok, non-skipped phase as the failure source
        const failPhase = phaseResults.find((p) => !p.ok && !p.skipped);
        const failKind = (failPhase?.phase ?? 'install') as VerifierFailure['kind'];
        failures.push({
          kind: failKind,
          message: `${failKind} failed (exit ${dockerResult.exitCode ?? 'timeout'})`,
          rawOutput: dockerResult.output.slice(-2000),
        });
      }

      for (const p of phaseResults) {
        const statusChar = p.skipped ? '-' : p.ok ? '✓' : '✗';
        process.stdout.write(`  ${p.phase}: ${statusChar}${p.skipped ? ' skipped' : ''}\n`);
      }
    } else {
      // ---- In-worktree mode: per-phase pnpm runs on host ----
      const PHASES = ['install', 'build', 'typecheck', 'lint', 'test'];

      for (const phase of PHASES) {
        const pr = runPhase(phase, worktreeDir);
        phaseResults.push(pr);

        if (pr.skipped) {
          process.stdout.write(`  ${phase}: skipped\n`);
          continue;
        }

        const statusChar = pr.ok ? '✓' : '✗';
        process.stdout.write(`  ${phase}: ${statusChar} ${pr.durationMs}ms\n`);

        if (!pr.ok) {
          finalStatus = 'failed';
          failures.push({
            kind: phase as VerifierFailure['kind'],
            message: `${phase} failed (exit ${pr.exitCode ?? 'timeout'})`,
            rawOutput: pr.output,
          });
          // Stop at first hard failure (install blocks everything)
          if (phase === 'install' || phase === 'build') break;
        }
      }
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - taskStart;

    // Persist to VerifierStoreBridge
    const runId = newVerifierRunId(randomUUID());
    bridge.insertRun({
      runId,
      taskId: task.id as TaskId,
      sprintId: SPRINT_ID,
      repoUrl: REPO_URL,
      branch: `pr-${task.prNumber}`,
      sha: task.sha,
      attempt: 1,
      startedAt: taskStart,
    });
    bridge.completeRun({
      runId,
      status: finalStatus,
      startedAt: taskStart,
      finishedAt,
      durationMs,
      attempt: 1,
      failures,
      phases: phaseResults.map((p) => ({
        kind: p.phase as VerifierFailure['kind'],
        ok: p.ok,
        exitCode: p.exitCode,
        durationMs: p.durationMs,
        skipped: p.skipped,
      })),
      costUsd: 0,
    });

    results.push({
      id: task.id,
      prNumber: task.prNumber,
      sha: task.sha,
      title: task.title,
      status: finalStatus,
      durationMs,
      failuresCount: failures.length,
      phases: phaseResults,
    });

    const statusLabel = finalStatus === 'passed' ? 'PASS' : 'FAIL';
    console.log(`  → ${statusLabel} (${Math.round(durationMs / 1000)}s)\n`);

    // Clean up worktree
    spawnSync('git', ['worktree', 'remove', '--force', worktreeDir], {
      cwd: baseCloneDir,
      timeout: 10_000,
    });
  }

  // ---- Summary ----
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const passRate = `${passed}/10`;
  const disagreement = bridge.disagreementRate();

  console.log('=== Results ===');
  console.log(`Sandbox: ${sandboxMode}`);
  console.log(`Pass: ${passed}  Fail: ${failed}  Error: ${errored}`);
  console.log(`Pass rate: ${passRate}`);
  console.log(`disagreementRate(): ${disagreement === null ? 'null (< 5 passed/failed samples)' : disagreement.toFixed(3)}`);
  console.log('');
  console.log('Per-task:');
  for (const r of results) {
    const icon = r.status === 'passed' ? '✓' : '✗';
    const failInfo = r.failuresCount > 0 ? ` (${r.failuresCount} failure(s))` : '';
    console.log(`  ${icon} ${r.id} PR#${r.prNumber} ${r.status}${failInfo} ${Math.round(r.durationMs / 1000)}s`);
    if (r.status === 'failed') {
      const failPhases = r.phases.filter((p) => !p.ok && !p.skipped);
      for (const fp of failPhases) {
        console.log(`      ${fp.phase}: exit ${fp.exitCode ?? 'timeout'}`);
        if (fp.output) {
          const lastLine = fp.output.trim().split('\n').slice(-3).join('\n');
          console.log(`      ${lastLine.replace(/\n/g, '\n      ')}`);
        }
      }
    }
  }

  // M1 DoD gate
  const m1Pass = passed >= 8;
  console.log('');
  console.log(`M1 DoD gate (>=8/10): ${m1Pass ? 'PASS' : 'FAIL'}`);

  // Write results file
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        sandboxMode,
        dockerImage: sandboxMode === 'docker' ? DOCKER_IMAGE : undefined,
        passRate: `${passed}/10`,
        disagreementRate: disagreement,
        m1DoDGate: m1Pass ? 'pass' : 'fail',
        tasks: results.map((r) => ({
          id: r.id,
          prNumber: r.prNumber,
          sha: r.sha.slice(0, 8),
          status: r.status,
          durationMs: r.durationMs,
          failuresCount: r.failuresCount,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to ${resultsPath}`);

  // Cleanup base clone
  rmSync(baseCloneDir, { recursive: true, force: true });

  if (!m1Pass) {
    console.error(`\n Docker M1 DoD not met (${passed}/10 < 8). Triage required.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
