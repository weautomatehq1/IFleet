#!/usr/bin/env node
/**
 * Phase A smoke test driver.
 *
 * Picks the next auto:ship issue from repos in config/repos.json, runs the full
 * Architect → Editor → Verify → Reviewer pipeline, and opens a PR.
 *
 * Usage:
 *   npx tsx scripts/run-smoke.ts [--version] [--issue <number>] [--dry-run]
 *
 * `--version` prints the package.json version and exits 0.
 *
 * `--dry-run` picks the next issue (read-only — no labels added, no
 * comments posted), prints the classification + worker plan, and exits 0
 * without spawning a worker or creating a worktree. Use it on launch eve
 * to verify queue + classifier wiring without burning a real run.
 *
 * Known Phase A limitations (surface them, don't hide them):
 *  1. The smoke driver now goes through `PipelineBridge` so it shares a
 *     `PipelineRunnerFactory` with the orchestrator (Phase B work). The
 *     bridge wraps `DefaultPipelineRunner` behind `WorkerAdapter`, which is
 *     what `SprintManager` consumes. Full SprintManager wiring (store +
 *     registry + pressure) is intentionally deferred — the bridge already
 *     gives both code paths a single seam.
 *  2. Cross-provider reviewer rule requires Codex; Codex is not yet enabled.
 *     We spoof reviewer.provider='codex' so the assertion passes, but both
 *     editor and reviewer run on Claude. Document this so Phase B can fix it.
 *  3. autonomy:review on the issue causes the architect to wait for a human
 *     comment before proceeding; we use autonomy:auto for the smoke issue
 *     so the pipeline completes end-to-end unattended.
 */

import { execFile, spawn as spawnChild } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.js';
import { promisify } from 'node:util';
import { symlinkSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Octokit } from '@octokit/rest';
import { createGitHubQueue } from '../src/queue/github.ts';
import { loadReposConfig } from '../src/config/repos.ts';
import { createIssueCommenter } from '../src/queue/issue-commenter.ts';
import { classifyTask } from '../src/classifier/index.ts';
import { createClaudeAdapter } from '../src/workers/claude.ts';
import { DefaultPipelineRunner } from '../src/pipeline/runner.ts';
import { createVerifyRunner } from '../src/verify/runner.ts';
import { titleToBranchName } from '../src/utils/branch-name.ts';
import { acquireDispatchLock } from './dispatcher-lock.ts';
import { broadcastIFleet } from '../src/observability/discord-broadcast.ts';
import { isFleetPaused, readPauseInfo } from '../src/orchestrator/fleet-control.ts';
import {
  PipelineBridge,
  decodeBridgeBrief,
  encodeBridgeBrief,
  type PipelineRunBootstrap,
  type PipelineRunnerFactory,
} from '../src/orchestrator/pipeline-bridge.ts';
import { newTaskId } from '../src/orchestrator/types.ts';
import type {
  WorkerPool,
  WorkerSpec,
  SpawnOpts as PipelineSpawnOpts,
  SpawnHandle as PipelineSpawnHandle,
  IssueCommenter,
  PrOpener,
  GitOps,
  QueuedTask as PipelineTask,
  PipelineInput,
  PipelineResult,
  RoutingDecision,
  VerifyRunner as PipelineVerifyRunner,
} from '../src/pipeline/types.ts';
import type { QueuedTask as RawTask } from '../src/queue/types.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const WORKTREES_DIR = join(REPO_ROOT, '.omc', 'worktrees');

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function buildWorkerPool(): WorkerPool {
  const claudeAdapter = createClaudeAdapter();

  return {
    spawn(spec: WorkerSpec, brief: string, opts: PipelineSpawnOpts): PipelineSpawnHandle {
      const workingDir = opts.worktreePath ?? REPO_ROOT;

      // Map pipeline model names to claude CLI aliases.
      const model = mapModel(spec.model);

      let rateLimitHits = 0;
      const workerHandle = claudeAdapter.spawn({
        taskId: `${opts.role}-${Date.now()}`,
        brief,
        model,
        workingDir,
        signal: opts.abortSignal,
        // Pass via --system-prompt so it overrides ~/.claude/CLAUDE.md for worker isolation.
        systemPrompt: opts.systemPrompt,
      });

      // Count rate limit events in the background.
      const eventLoop = (async () => {
        for await (const event of workerHandle.events) {
          if (event.kind === 'rate_limit') rateLimitHits++;
          if (event.kind === 'progress') process.stdout.write('.');
          if (event.kind === 'error') log(`[worker-error] role=${opts.role} cat=${event.category} msg=${event.message}`);
        }
      })();

      return {
        result: async () => {
          const r = await workerHandle.result;
          // Drain the event loop so late errors are not lost.
          await eventLoop;
          return {
            ok: r.ok,
            output: r.text,
            sessionId: r.sessionId,
            rateLimitHits,
            ...(r.totalCostUsd !== undefined && { totalCostUsd: r.totalCostUsd }),
          };
        },
        cancel: workerHandle.cancel,
      };
    },
  };
}

function mapModel(configModel: string): string {
  // Phase B: classifier owns model selection. Architect opus is gated on the
  // `complexity:high` issue label (see src/classifier/index.ts); without it
  // the classifier returns sonnet, so this is a pass-through for full Claude
  // model names. Legacy tier shorthand kept for back-compat.
  const shorthand: Record<string, string> = {
    'opus-4.7': 'claude-opus-4-7',
    'sonnet-4.6': 'claude-sonnet-4-6',
    'haiku-4.5': 'claude-haiku-4-5-20251001',
  };
  return shorthand[configModel] ?? configModel;
}

function buildGitOps(): GitOps {
  return {
    async diff(worktreePath: string, baseRef: string): Promise<string> {
      const { stdout } = await execFileAsync('git', ['diff', baseRef], { cwd: worktreePath });
      return stdout;
    },
    async currentBranch(worktreePath: string): Promise<string> {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: worktreePath,
      });
      return stdout.trim();
    },
  };
}

function buildVerifyAdapter(): PipelineVerifyRunner {
  const runner = createVerifyRunner();
  return {
    async run(worktreePath, kinds) {
      const result = await runner.run(worktreePath, kinds);
      const failures = Object.entries(result.perKind)
        .filter(([k, v]) => kinds.includes(k as typeof kinds[number]) && !v.ok)
        .map(([k, v]) => ({ kind: k as typeof kinds[number], log: v.output }));
      return { ok: result.ok, failures };
    },
  };
}

interface PipelineFactoryDeps {
  workerPool: WorkerPool;
  worktreePath: string;
  routing: RoutingDecision;
  verify: PipelineVerifyRunner;
  issues: IssueCommenter;
  pr: PrOpener;
  git: GitOps;
  abortController: AbortController;
  captured: { result?: PipelineResult };
}

function makePipelineFactory(deps: PipelineFactoryDeps): PipelineRunnerFactory {
  return async (_taskId, brief, _opts): Promise<PipelineRunBootstrap> => {
    const decoded = decodeBridgeBrief(brief);
    if (!decoded) {
      throw new Error('pipeline-bridge brief is not a structured QueuedTask payload');
    }
    const innerRunner = new DefaultPipelineRunner();
    const runner = {
      async run(input: PipelineInput) {
        const result = await innerRunner.run(input);
        deps.captured.result = result;
        return result;
      },
    };
    const input: PipelineInput = {
      task: decoded,
      workerPool: deps.workerPool,
      worktreePath: deps.worktreePath,
      routing: deps.routing,
      abortSignal: deps.abortController.signal,
      verify: deps.verify,
      issues: deps.issues,
      pr: deps.pr,
      git: deps.git,
      codeowners: ['@monstersebas1'],
      baseBranch: 'main',
      approver: '@monstersebas1',
      repoRoot: REPO_ROOT,
    };
    return { runner, input, abortController: deps.abortController };
  };
}

function buildPrOpener(): PrOpener {
  return {
    async open(input) {
      // Push the editor's commits to origin before creating the PR.
      const worktreePath = join(WORKTREES_DIR, `smoke-${input.issueNumber}`);
      await execFileAsync('git', ['push', '-u', 'origin', input.headBranch], {
        cwd: worktreePath,
      });
      const { stdout } = await execFileAsync('gh', [
        'pr',
        'create',
        '--repo',
        input.repo,
        '--head',
        input.headBranch,
        '--base',
        input.baseBranch,
        '--title',
        input.title,
        '--body',
        input.body,
      ]);
      const url = stdout.trim();
      const match = url.match(/\/(\d+)$/);
      return { url, number: match?.[1] ? parseInt(match[1], 10) : 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

async function setupWorktree(issueNumber: number, branchName: string): Promise<string> {
  const worktreePath = join(WORKTREES_DIR, `smoke-${issueNumber}`);
  mkdirSync(WORKTREES_DIR, { recursive: true });

  // Remove stale worktree if exists. git worktree remove only works when the
  // path is still registered; fall back to rm -rf for preserved failure worktrees.
  if (existsSync(worktreePath)) {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: REPO_ROOT,
    }).catch(() => rmSync(worktreePath, { recursive: true, force: true }));
    await execFileAsync('git', ['worktree', 'prune'], { cwd: REPO_ROOT }).catch(() => undefined);
  }

  // Delete stale branch if it exists from a previous failed run.
  await execFileAsync('git', ['branch', '-D', branchName], { cwd: REPO_ROOT }).catch(
    () => undefined,
  );

  await execFileAsync(
    'git',
    ['worktree', 'add', '-b', branchName, worktreePath, 'main'],
    { cwd: REPO_ROOT },
  );

  // Symlink node_modules so verify can run npm scripts.
  // On Windows, use 'junction' so the operation does not require Developer Mode
  // or elevated privileges (regular symlinks fail with EPERM otherwise). On
  // POSIX, Node ignores the type argument and creates a normal symlink.
  const nmTarget = join(worktreePath, 'node_modules');
  if (!existsSync(nmTarget)) {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(join(REPO_ROOT, 'node_modules'), nmTarget, linkType);
  }

  log(`Worktree created at ${worktreePath} on branch ${branchName}`);
  return worktreePath;
}

async function teardownWorktree(issueNumber: number, branchName?: string): Promise<void> {
  const worktreePath = join(WORKTREES_DIR, `smoke-${issueNumber}`);
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: REPO_ROOT,
  }).catch(() => undefined);
  await execFileAsync('git', ['worktree', 'prune'], { cwd: REPO_ROOT }).catch(() => undefined);
  if (branchName) {
    // Only delete if it hasn't been pushed (local-only cleanup).
    await execFileAsync('git', ['branch', '-D', branchName], { cwd: REPO_ROOT }).catch(
      () => undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[smoke ${new Date().toISOString()}] ${msg}`);
}

// notify wraps the shared broadcaster so this script's existing call sites
// don't need touching. Centralising the HTTP path means the daemon and the
// smoke runner share one notification contract (see feedback_ifleet_visibility).
const notify = broadcastIFleet;

// ---------------------------------------------------------------------------
// Worker mode — runs the full pipeline for a pre-picked issue.
// Spawned as a detached child by the scheduler so PM2 cron_restart can't
// kill it mid-pipeline.
// ---------------------------------------------------------------------------

async function runWorkerMode(issueNumber: number): Promise<void> {
  const stateFile = join(REPO_ROOT, '.omc', 'state', `pipeline-${issueNumber}.json`);
  if (!existsSync(stateFile)) {
    log(`[worker] State file missing: ${stateFile}`);
    process.exitCode = 1;
    return;
  }

  const { rawTask, branchName, worktreePath } = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    rawTask: RawTask;
    branchName: string;
    worktreePath: string;
  };
  const startedAt = Date.now();

  const reposMap = loadReposConfig(resolve(REPO_ROOT, 'config', 'repos.json'));
  const queue = await createGitHubQueue({ repos: Object.values(reposMap) });

  const pipelineTask: PipelineTask = {
    id: rawTask.id,
    issueNumber: rawTask.issueNumber,
    repo: rawTask.repo,
    title: rawTask.title,
    body: rawTask.body,
    autonomy: rawTask.routingHints.autonomy,
    labels: rawTask.labels,
  };

  const routing = classifyTask({ title: rawTask.title, body: rawTask.body, labels: rawTask.labels });
  const [owner, repoName] = rawTask.repo.split('/') as [string, string];

  let ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']).catch(() => ({ stdout: '' }));
    ghToken = stdout.trim() || undefined;
  }
  if (!ghToken) throw new Error('No GitHub token: set GITHUB_TOKEN or run `gh auth login`');
  const octokit = new Octokit({ auth: ghToken });

  const abortController = new AbortController();
  const captured: { result?: PipelineResult } = {};
  const factory = makePipelineFactory({
    workerPool: buildWorkerPool(),
    worktreePath,
    routing,
    verify: buildVerifyAdapter(),
    issues: createIssueCommenter(octokit, owner, repoName),
    pr: buildPrOpener(),
    git: buildGitOps(),
    abortController,
    captured,
  });

  notify(`▶ Sprint started: #${issueNumber} — ${rawTask.title}`);
  log(`[worker] Running pipeline for #${issueNumber}...`);
  log('[worker]   Phases: Architect → Editor → Verify → Reviewer → PR');

  const bridge = new PipelineBridge(factory);
  let result;
  try {
    const handle = await bridge.spawn(newTaskId(rawTask.id), encodeBridgeBrief(pipelineTask), {});
    const spawnResult = await handle.done;
    if (!captured.result) {
      throw new Error(spawnResult.error ?? `pipeline did not produce a result (exit ${spawnResult.exitCode})`);
    }
    result = captured.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[worker] Pipeline threw: ${msg}`);
    notify(`❌ Sprint failed: #${issueNumber} — ${msg}`);
    await queue.markFailed(rawTask as Parameters<typeof queue.markFailed>[0], msg);
    await teardownWorktree(issueNumber, branchName);
    rmSync(stateFile, { force: true });
    process.exitCode = 1;
    return;
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`[worker] Pipeline finished in ${durationSec}s — status: ${result.status}`);

  if (result.status === 'pr_opened' && result.prUrl) {
    notify(`✅ PR opened: #${issueNumber} — ${rawTask.title}\n${result.prUrl}`);
    await queue.markCompleted(rawTask as Parameters<typeof queue.markCompleted>[0], result.prUrl);
    await teardownWorktree(issueNumber, branchName);
    rmSync(stateFile, { force: true });
    log('[worker] PHASE A GREEN — smoke PR is open. Do not merge without Seb review.');
  } else {
    const reason = result.failureReason ?? result.status;
    log(`[worker] Pipeline did not open a PR: ${reason}`);
    notify(`❌ Sprint failed: #${issueNumber} — ${reason}`);
    await queue.markFailed(rawTask as Parameters<typeof queue.markFailed>[0], reason);
    log(`[worker] Worktree preserved at ${worktreePath} for inspection`);
    rmSync(stateFile, { force: true });
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  // Single source of truth for the pause flag — same helper the daemon and
  // /pause /continue Discord commands use (AUDIT-IFleet-6fa2869e). Keeping
  // the path derivation inside fleet-control means future changes (renames,
  // moves, IFLEET_REPO_ROOT semantics) only have one site to update.
  if (isFleetPaused(REPO_ROOT)) {
    const info = readPauseInfo(REPO_ROOT);
    log(
      `Fleet is paused${info.by ? ` (by ${info.by})` : ''}${
        info.reason ? ` — ${info.reason}` : ''
      }. Run /continue in Discord or remove .omc/PAUSED to resume.`,
    );
    return;
  }

  // Handle --version flag
  if (process.argv.includes('--version')) {
    const pkgPath = join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    console.log(pkg.version);
    process.exitCode = 0;
    return;
  }

  // Worker mode: spawned detached by the scheduler to outlive cron restarts.
  // Workers bypass the dispatch lock — they don't pick issues, just run pipelines.
  const workerFlag = process.argv.indexOf('--worker');
  if (workerFlag !== -1) {
    const issueNumber = parseInt(process.argv[workerFlag + 1] ?? '', 10);
    if (!Number.isFinite(issueNumber)) {
      log('[worker] Invalid --worker argument');
      process.exitCode = 1;
      return;
    }
    await runWorkerMode(issueNumber);
    return;
  }

  // Acquire single-dispatcher lock before any GitHub I/O.
  // PM2 cron_restart can race with overlapping invocations (or other triggers
  // like MCP submitSprint), and `pickNext` is not atomic — two concurrent
  // dispatchers will both claim the same auto:ship issue. The lock fences
  // that race regardless of who fired the second invocation.
  const lockResult = acquireDispatchLock(join(REPO_ROOT, '.omc', 'dispatcher.lock'));
  if (!lockResult.ok) {
    if (lockResult.reason === 'held-by-live-pid') {
      log(`Another dispatcher run is in progress (pid ${lockResult.heldByPid}). Exit 0.`);
      return;
    }
    log(`ERROR: Could not acquire dispatcher lock: ${lockResult.error ?? 'unknown'}. Exit 1.`);
    process.exitCode = 1;
    return;
  }
  const releaseLock = lockResult.lock.release;

  try {
    await runDispatch();
  } finally {
    releaseLock();
  }
}

async function runDispatch(): Promise<void> {

  // Parse optional --issue flag to target a specific issue number.
  const issueFlag = process.argv.indexOf('--issue');
  const targetIssueNumber = issueFlag !== -1 ? parseInt(process.argv[issueFlag + 1] ?? '', 10) : undefined;
  const dryRun = process.argv.includes('--dry-run');

  log(`Phase A smoke test starting${dryRun ? ' (dry-run — no side effects)' : ''}`);

  const reposMap = loadReposConfig(resolve(REPO_ROOT, 'config', 'repos.json'));
  const queue = await createGitHubQueue({
    repos: Object.values(reposMap),
  });

  // Restore `auto:ship` on any issues that have served their 30-min cooldown
  // after a prior failure (see GitHubQueue.markFailed). Runs before pickNext
  // so a freshly-restored issue can be picked up this same tick.
  if (!dryRun) {
    try {
      const sweep = await queue.sweepCooldowns();
      if (sweep.restored > 0 || sweep.remaining > 0) {
        log(`Cooldown sweep: restored=${sweep.restored} remaining=${sweep.remaining}`);
      }
    } catch (err) {
      log(`Cooldown sweep failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log('Picking next issue...');
  const rawTask = await queue.pickNext();
  if (!rawTask) {
    if (dryRun) {
      log('[dry-run] No eligible issues (none with auto:ship without in_flight). Exit 0.');
      return;
    }
    log('ERROR: No issues ready to pick. Create a GitHub issue with the label auto:ship and rerun.');
    process.exitCode = 1;
    return;
  }

  if (targetIssueNumber !== undefined && rawTask.issueNumber !== targetIssueNumber) {
    log(`WARNING: Picked issue #${rawTask.issueNumber} but --issue requested #${targetIssueNumber}.`);
  }

  log(`Picked issue #${rawTask.issueNumber}: "${rawTask.title}"`);
  log(`Labels: ${rawTask.labels.join(', ')}`);
  log(`Autonomy: ${rawTask.routingHints.autonomy} | Priority: ${rawTask.routingHints.priority}`);

  if (dryRun) {
    const planRouting = classifyTask({
      title: rawTask.title,
      body: rawTask.body,
      labels: rawTask.labels,
    });
    log(
      `[dry-run] routing → architect=${planRouting.architect.model} ` +
        `editor=${planRouting.editor.model} reviewer=${planRouting.reviewer.model}`,
    );
    log('[dry-run] queue.pickNext is read-only; no labels added, no comments posted');
    log('[dry-run] exit 0 without spawning workers or creating a worktree');
    return;
  }

  // Mark as in-flight.
  await queue.markPicked(rawTask, 'claude-max-1');
  log('Marked issue as in_flight');

  // Derive a safe branch name.
  let branchName: string;
  let worktreePath: string;
  try {
    branchName = titleToBranchName(rawTask.issueNumber, rawTask.title);
    worktreePath = await setupWorktree(rawTask.issueNumber, branchName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Worktree setup failed: ${msg}`);
    // Best-effort teardown in case the worktree was partially created.
    await teardownWorktree(rawTask.issueNumber).catch(() => undefined);
    await queue.markFailed(rawTask, `worktree-setup-failed: ${msg}`);
    process.exitCode = 1;
    return;
  }

  // Persist task state and spawn a detached pipeline worker.
  // The cron_restart kills this scheduler process every 5 minutes; the worker
  // must be detached so it outlives the cron and runs to completion.
  const stateDir = join(REPO_ROOT, '.omc', 'state');
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, `pipeline-${rawTask.issueNumber}.json`);
  writeFileSync(stateFile, JSON.stringify({ rawTask, branchName, worktreePath }));

  const logsDir = join(REPO_ROOT, '.omc', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, `worker-${rawTask.issueNumber}.log`);
  const logFd = openSync(logFile, 'a');
  const worker = spawnChild(
    process.execPath,
    ['--import', 'tsx', resolve(REPO_ROOT, 'scripts', 'run-smoke.ts'), '--worker', String(rawTask.issueNumber)],
    { detached: true, stdio: ['ignore', logFd, logFd], cwd: REPO_ROOT, env: process.env },
  );
  worker.unref();
  log(`Detached pipeline worker (PID ${worker.pid ?? '?'}) for #${rawTask.issueNumber} — logs → ${logFile} — scheduler exiting`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[smoke] Fatal:', err);
    process.exitCode = 1;
  });
}
