#!/usr/bin/env node
/**
 * M1 DoD eval replay — runs 10 historical IFleet PRs through the verifier
 * (in-worktree mode, no Docker) and records the first real disagreementRate().
 *
 * Usage: node --import tsx scripts/eval-replay.ts
 *
 * The script clones IFleet once into /tmp, creates a git worktree per SHA,
 * runs pnpm install + typecheck + lint + test, then persists results via
 * VerifierStoreBridge and queries disagreementRate().
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

  // Clone IFleet into a temp base dir
  const baseCloneDir = mkdtempSync(join(tmpdir(), 'ifleet-eval-base-'));
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

    const worktreeDir = join(tmpdir(), `ifleet-eval-${task.id}`);
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
    const phaseResults: PhaseResult[] = [];
    const failures: VerifierFailure[] = [];
    let finalStatus: VerifierStatus = 'passed';

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
  console.log(`M1 DoD gate (≥8/10): ${m1Pass ? 'PASS ✓' : 'FAIL ✗'}`);

  // Write results file
  const resultsPath = join(process.cwd(), '.ifleet/eval/replay-results.json');
  writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
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
    console.error(`\n⛔ M1 DoD not met (${passed}/10 < 8). Stopping — triage required.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
