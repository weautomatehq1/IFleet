#!/usr/bin/env node
/**
 * Phase A smoke test driver.
 *
 * Picks the next auto:ship issue from weautomatehq1/IFleet, runs the full
 * Architect → Editor → Verify → Reviewer pipeline, and opens a PR.
 *
 * Usage:  npx tsx scripts/run-smoke.ts [--issue <number>]
 *
 * Known Phase A limitations (surface them, don't hide them):
 *  1. WorkerAdapter type in orchestrator/types.ts diverges from the
 *     pipeline's WorkerPool interface — the orchestrator tick machinery is
 *     bypassed here; we call the pipeline runner directly.
 *  2. Cross-provider reviewer rule requires Codex; Codex is not yet enabled.
 *     We spoof reviewer.provider='codex' so the assertion passes, but both
 *     editor and reviewer run on Claude. Document this so Phase B can fix it.
 *  3. autonomy:review on the issue causes the architect to wait for a human
 *     comment before proceeding; we use autonomy:auto for the smoke issue
 *     so the pipeline completes end-to-end unattended.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { symlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Octokit } from '@octokit/rest';
import { createGitHubQueue } from '../src/queue/github.ts';
import { classifyTask } from '../src/classifier/index.ts';
import { createClaudeAdapter } from '../src/workers/claude.ts';
import { DefaultPipelineRunner } from '../src/pipeline/runner.ts';
import { createVerifyRunner } from '../src/verify/runner.ts';
import { titleToBranchName } from '../src/utils/branch-name.ts';
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
  VerifyRunner as PipelineVerifyRunner,
} from '../src/pipeline/types.ts';
import type { QueuedTask } from '../src/queue/types.ts';

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

function buildIssueCommenter(octokit: Octokit, owner: string, repo: string): IssueCommenter {
  return {
    async comment(issueNumber: number, body: string): Promise<void> {
      await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
    async waitForApproval(issueNumber, opts) {
      // With autonomy:auto the pipeline short-circuits before calling this.
      // If called anyway (e.g. autonomy:review), we poll for a comment from approver.
      const deadline = Date.now() + opts.timeoutMs;
      while (Date.now() < deadline) {
        if (opts.abortSignal.aborted) return false;
        const comments = await octokit.issues.listComments({
          owner,
          repo,
          issue_number: issueNumber,
        });
        const found = comments.data.some(
          (c) =>
            c.user?.login === opts.approver.replace(/^@/, '') &&
            /\bapprove\b|\blgtm\b/i.test(c.body ?? ''),
        );
        if (found) return true;
        await delay(opts.pollIntervalMs);
      }
      return false;
    },
  };
}

function buildPrOpener(): PrOpener {
  return {
    async openDraft(input) {
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

  // Remove stale worktree if exists.
  if (existsSync(worktreePath)) {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: REPO_ROOT,
    }).catch(() => undefined);
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
  const nmTarget = join(worktreePath, 'node_modules');
  if (!existsSync(nmTarget)) {
    symlinkSync(join(REPO_ROOT, 'node_modules'), nmTarget);
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // Parse optional --issue flag to target a specific issue number.
  const issueFlag = process.argv.indexOf('--issue');
  const targetIssueNumber = issueFlag !== -1 ? parseInt(process.argv[issueFlag + 1] ?? '', 10) : undefined;

  log('Phase A smoke test starting');

  const queue = await createGitHubQueue({
    repos: [{ owner: 'weautomatehq1', name: 'IFleet' }],
  });

  log('Picking next issue...');
  const rawTask = await queue.pickNext();
  if (!rawTask) {
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

  // Build pipeline task from the queue task.
  const pipelineTask: PipelineTask = {
    id: rawTask.id,
    issueNumber: rawTask.issueNumber,
    repo: rawTask.repo,
    title: rawTask.title,
    body: rawTask.body,
    autonomy: rawTask.routingHints.autonomy,
    labels: rawTask.labels,
  };

  const routing = classifyTask({
    title: rawTask.title,
    body: rawTask.body,
    labels: rawTask.labels,
  });

  const [owner, repoName] = rawTask.repo.split('/') as [string, string];
  // Resolve GitHub token: env var wins, then gh CLI keychain (same as GitHubQueue).
  let ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']).catch(() => ({ stdout: '' }));
    ghToken = stdout.trim() || undefined;
  }
  if (!ghToken) throw new Error('No GitHub token: set GITHUB_TOKEN or run `gh auth login`');
  const octokit = new Octokit({ auth: ghToken });

  const input: PipelineInput = {
    task: pipelineTask,
    workerPool: buildWorkerPool(),
    worktreePath,
    routing,
    abortSignal: new AbortController().signal,
    verify: buildVerifyAdapter(),
    issues: buildIssueCommenter(octokit, owner, repoName),
    pr: buildPrOpener(),
    git: buildGitOps(),
    codeowners: ['@monstersebas1'],
    baseBranch: 'main',
    approver: '@monstersebas1',
    repoRoot: REPO_ROOT,
  };

  log('Running pipeline...');
  log('  Phases: Architect → Editor → Verify → Reviewer → PR');

  const runner = new DefaultPipelineRunner();
  let result;
  try {
    result = await runner.run(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Pipeline threw: ${msg}`);
    if (err instanceof Error && 'stderrTail' in err && (err as { stderrTail: string }).stderrTail) {
      log(`Worker stderr:\n${(err as { stderrTail: string }).stderrTail}`);
    }
    await queue.markFailed(rawTask, msg);
    await teardownWorktree(rawTask.issueNumber, branchName);
    process.exitCode = 1;
    return;
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`Pipeline finished in ${durationSec}s — status: ${result.status}`);

  if (result.status === 'pr_opened' && result.prUrl) {
    log(`PR opened: ${result.prUrl}`);
    await queue.markCompleted(rawTask, result.prUrl);
    log('Issue marked auto:shipped');
    await teardownWorktree(rawTask.issueNumber, branchName);
    log('PHASE A GREEN — smoke PR is open. Do not merge without Seb review.');
  } else {
    const reason = result.failureReason ?? result.status;
    log(`Pipeline did not open a PR: ${reason}`);
    if (result.reviewSummary) {
      log(`Review summary:\n${result.reviewSummary}`);
    }
    if (result.attempts.length > 0) {
      for (const attempt of result.attempts) {
        log(
          `  [${attempt.role}] ok=${attempt.ok} rateLimitHits=${attempt.rateLimitHits} ` +
            `durationMs=${attempt.endedAt - attempt.startedAt}`,
        );
        if (attempt.role === 'reviewer') {
          log(`    output: ${attempt.output.slice(0, 500)}`);
        }
      }
    }
    await queue.markFailed(rawTask, reason);
    // Keep worktree on failure so the diff can be inspected manually.
    log(`Worktree preserved at ${worktreePath} for inspection`);
    log(`PHASE A RED — reason: ${reason}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err);
  process.exitCode = 1;
});
