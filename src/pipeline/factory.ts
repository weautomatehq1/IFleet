import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Octokit } from '@octokit/rest';
import { classifyTask } from '../classifier/index.js';
import {
  decodeBridgeBrief,
  type PipelineRunBootstrap,
  type PipelineRunnerFactory,
} from '../orchestrator/pipeline-bridge.js';
import type { WorkerConfig } from '../orchestrator/types.js';
import { createIssueCommenter } from '../queue/issue-commenter.js';
import { titleToBranchName } from '../utils/branch-name.js';
import { createVerifyRunner } from '../verify/runner.js';
import { createAccountPool, type AccountPool } from '../workers/account-pool.js';
import { getActivePipelineAdapter } from '../workers/adapters/index.js';
import { DefaultPipelineRunner } from './runner.js';
import type {
  GitOps,
  IssueCommenter,
  PipelineInput,
  PipelineResult,
  PrOpener,
  SpawnHandle as PipelineSpawnHandle,
  SpawnOpts as PipelineSpawnOpts,
  VerifyRunner,
  WorkerPool,
  WorkerSpec,
} from './types.js';


const execFileAsync = promisify(execFile);

// Claude Max window default — used when a `rate_limit` event reaches the
// pipeline without a precise reset timestamp. Pausing the worker for the
// full 5h window is the safest default because the CLI's terminal
// rate_limit_event sometimes omits `resetsAt`, in which case `retryDelayMs`
// arrives as 0. A shorter default would let the pool re-pick a worker that
// is still inside its rejected window. See ADR-0004 §Context bullet 1.
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// Worker Claude permissions written into each worktree's `.claude/settings.json`.
//
// Defense-in-depth, not a sandbox. Workers can still execute arbitrary code
// through `node`/`npm`/`npx`/`pnpm`/`vitest` — those are needed for verify
// steps. The point of this allow/deny pair is to remove the *trivial*
// destructive escape hatches (`git push --force`, `git reset --hard`,
// `rm -rf`) that prompt-only rules at `src/pipeline/prompts.ts:68` cannot
// enforce against a hallucinating model.
//
// Git is read-only from the worker's side: the pipeline host owns
// `git add` / `git commit` / `git push` (see `src/pipeline/editor.ts:78,90`
// and `buildPrOpener` in this file).
//
// Claude's permission engine concatenates allow/deny across config scopes and
// deny takes precedence, so the explicit deny block is the load-bearing half —
// it catches inherited broad allows and forbids the high-risk forms even if a
// future operator widens the allow list. See
// https://code.claude.com/docs/en/permissions
export const WORKER_CLAUDE_PERMISSIONS = {
  allow: [
    'Bash(git status)',
    'Bash(git status *)',
    'Bash(git diff)',
    'Bash(git diff *)',
    'Bash(git log)',
    'Bash(git log *)',
    'Bash(git show)',
    'Bash(git show *)',
    'Bash(git rev-parse *)',
    'Bash(git branch --show-current)',
    'Bash(git branch --list *)',
    'Bash(pnpm *)',
    'Bash(npm *)',
    'Bash(npx *)',
    'Bash(node *)',
    'Bash(tsc *)',
    'Bash(tsx *)',
    'Bash(eslint *)',
    'Bash(vitest *)',
    'Bash(ls *)',
    'Bash(cat *)',
    'Bash(grep *)',
    'Bash(find *)',
    'Bash(mkdir *)',
    'Bash(mv *)',
    'Bash(cp *)',
    'Edit(*)',
    'Write(*)',
    'Read(*)',
    'Glob(*)',
    'Grep(*)',
    'TodoWrite(*)',
  ],
  deny: [
    'Bash(git add *)',
    'Bash(git commit *)',
    'Bash(git push *)',
    'Bash(git reset *)',
    'Bash(git checkout *)',
    'Bash(git switch *)',
    'Bash(git clean *)',
    'Bash(git branch -D *)',
    'Bash(git branch -d *)',
    'Bash(git branch --delete *)',
    'Bash(git rebase *)',
    'Bash(git merge *)',
    'Bash(git worktree *)',
    'Bash(rm *)',
    'Bash(sudo *)',
    'Bash(chmod *)',
    'Bash(chown *)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Bash(ssh *)',
    'Bash(scp *)',
  ],
} as const;

export interface ProductionFactoryOpts {
  repoRoot: string;
  /** Defaults to 'weautomatehq1/IFleet' — legacy callers work without providing it. */
  repoId?: string;
  octokit: Octokit;
  /** Pre-built VerifyRunner; defaults to createVerifyRunner() when omitted. */
  verify?: VerifyRunner;
  codeowners?: string[];
  approver?: string;
  initialWorkers: ReadonlyArray<WorkerConfig>;
}

export interface ProductionFactory {
  factory: PipelineRunnerFactory;
  /** Call when WorkerRegistry.onReload fires to refresh the account pool. */
  rebuildPool: (workers: ReadonlyArray<WorkerConfig>) => void;
}

/**
 * Builds a production {@link PipelineRunnerFactory} wired with real collaborators.
 * Returns both the factory and a `rebuildPool` callback that should be called
 * whenever `WorkerRegistry.onReload` fires (Item 4 integration point).
 */
export function makeProductionFactory(opts: ProductionFactoryOpts): ProductionFactory {
  const repoId = opts.repoId ?? 'weautomatehq1/IFleet';
  const parts = repoId.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repoId must be "owner/name", got: ${repoId}`);
  }
  const [repoOwner, repoName] = parts as [string, string];
  const worktreesDir = join(opts.repoRoot, '.omc', 'worktrees');
  const verify = opts.verify ?? buildVerifyAdapter();

  let pool: AccountPool = createAccountPool(opts.initialWorkers);

  function rebuildPool(workers: ReadonlyArray<WorkerConfig>): void {
    pool = createAccountPool(workers);
  }

  const factory: PipelineRunnerFactory = async (_taskId, brief, _spawnOpts): Promise<PipelineRunBootstrap> => {
    const task = decodeBridgeBrief(brief);
    if (!task) throw new Error('brief is not a structured QueuedTask payload');

    const worker = pool.nextWorker();
    const worktreeKey = task.issueNumber > 0 ? String(task.issueNumber) : task.id;
    const branchName = titleToBranchName(task.issueNumber > 0 ? task.issueNumber : task.id, task.title);
    const worktreePath = await setupWorktree(worktreeKey, branchName, worktreesDir, opts.repoRoot);

    const workerPool = buildWorkerPool(worker, pool);
    const routing = classifyTask({ title: task.title, body: task.body, labels: task.labels, mode: task.mode });
    const abortController = new AbortController();

    const issues: IssueCommenter = createIssueCommenter(opts.octokit, repoOwner, repoName);
    const pr: PrOpener = buildPrOpener(repoId, worktreePath, opts.repoRoot);
    const git: GitOps = buildGitOps();

    const input: PipelineInput = {
      task,
      workerPool,
      worktreePath,
      routing,
      abortSignal: abortController.signal,
      verify,
      issues,
      pr,
      git,
      codeowners: opts.codeowners ?? ['@monstersebas1'],
      baseBranch: 'main',
      approver: opts.approver ?? '@monstersebas1',
      repoRoot: opts.repoRoot,
      reviewerMaxRounds: 3,
    };

    return {
      runner: new DefaultPipelineRunner(),
      input,
      abortController,
      workerId: worker.id,
      teardown: async (_result: PipelineResult | Error) => {
        await teardownWorktree(worktreeKey, branchName, worktreesDir, opts.repoRoot);
      },
    };
  };

  return { factory, rebuildPool };
}

// ---------------------------------------------------------------------------
// Internal collaborator builders
// ---------------------------------------------------------------------------

export function buildWorkerPool(
  workerConfig: WorkerConfig,
  accountPool?: AccountPool,
): WorkerPool {
  const adapter = getActivePipelineAdapter();

  return {
    spawn(spec: WorkerSpec, brief: string, opts: PipelineSpawnOpts): PipelineSpawnHandle {
      // Refuse to fall back to the daemon's cwd (the host repo). Every pipeline
      // stage MUST opt into a worktree explicitly — the original worktree-cwd
      // bug was caused by stages not threading this through. Throwing here
      // catches any future regression at the seam instead of silently writing
      // commits into the host IFleet checkout.
      if (!opts.worktreePath) {
        throw new Error(
          `buildWorkerPool.spawn refused: role="${opts.role}" called without worktreePath. ` +
            `Pipeline stages must pass input.worktreePath to keep work sandboxed. ` +
            `Falling back to process.cwd() ("${resolve('.')}") would risk committing ` +
            `into the host repo (see PR #161).`,
        );
      }
      const workingDir = opts.worktreePath;
      const model = mapModel(spec.model);
      let rateLimitHits = 0;

      // Architect receives user-controlled brief → keep injection wrapper.
      // All other roles (editor, doctor, reviewer) receive trusted pipeline
      // content (the architect plan) → skip the wrapper so Claude follows it.
      const trustedBrief = opts.role !== 'architect';
      const workerHandle = adapter.spawn({
        taskId: `${opts.role}-${Date.now()}`,
        brief,
        model,
        workingDir,
        signal: opts.abortSignal,
        systemPrompt: opts.systemPrompt,
        authProfile: workerConfig.authProfile,
        trustedBrief,
      });

      const eventLoop = (async () => {
        for await (const event of workerHandle.events) {
          if (event.kind === 'rate_limit') {
            rateLimitHits++;
            // ADR-0004 §Context bullet 1 — wire the rate_limit signal into
            // the AccountPool so subsequent acquire() calls skip this worker
            // until the pause expires. `retryDelayMs` is normally derived
            // from the CLI's `resetsAt`; when it is 0 (terminal event with no
            // reset timestamp) fall back to the Claude Max 5h window.
            if (accountPool !== undefined) {
              const retryAfterMs = event.retryDelayMs > 0 ? event.retryDelayMs : FIVE_HOURS_MS;
              accountPool.markRateLimited(workerConfig.id, retryAfterMs);
            }
          }
        }
      })();

      return {
        result: async () => {
          const r = await workerHandle.result;
          await eventLoop;
          const baseResult = {
            ok: r.ok,
            output: r.text,
            sessionId: r.sessionId,
            rateLimitHits,
            ...(r.rateLimited ? { rateLimited: true as const } : {}),
          };
          if (typeof r.inputTokens === 'number' && typeof r.outputTokens === 'number') {
            return { ...baseResult, totalTokens: r.inputTokens + r.outputTokens };
          }
          return baseResult;
        },
        cancel: workerHandle.cancel,
      };
    },
  };
}

function mapModel(configModel: string): string {
  const shorthand: Record<string, string> = {
    'opus-4.7': 'claude-opus-4-7',
    'sonnet-4.6': 'claude-sonnet-4-6',
    'haiku-4.5': 'claude-haiku-4-5-20251001',
  };
  return shorthand[configModel] ?? configModel;
}

function buildVerifyAdapter(): VerifyRunner {
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

function buildGitOps(): GitOps {
  return {
    async diff(worktreePath: string, baseRef: string): Promise<string> {
      // Include both committed changes (HEAD vs base) and any uncommitted
      // working-tree changes. The editor is instructed to commit, so the
      // committed diff (baseRef..HEAD) is the primary signal.
      const [{ stdout: committed }, { stdout: unstaged }] = await Promise.all([
        execFileAsync('git', ['diff', `${baseRef}..HEAD`], { cwd: worktreePath }).catch(() => ({ stdout: '' })),
        execFileAsync('git', ['diff'], { cwd: worktreePath }).catch(() => ({ stdout: '' })),
      ]);
      // Concatenate so the reviewer / PR opener sees both halves. The editor
      // is instructed to commit, so `unstaged` is usually empty — but if
      // `git add -A` partially failed (locked files, permissions) the
      // remaining changes would silently disappear with a simple OR.
      return [committed, unstaged].filter((s) => s.length > 0).join('\n');
    },
    async currentBranch(worktreePath: string): Promise<string> {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: worktreePath });
      return stdout.trim();
    },
  };
}

/**
 * Normalize reviewer logins for the `gh` CLI: strip leading `@` (config and
 * CODEOWNERS files store `@user`, but `gh` wants the bare login) and drop
 * empty entries. A stray `@` makes `gh` reject the login outright.
 */
export function normalizeReviewers(reviewers: string[]): string[] {
  return reviewers.map((r) => r.replace(/^@+/, '').trim()).filter((r) => r.length > 0);
}

function buildPrOpener(repoId: string, worktreePath: string, _repoRoot: string): PrOpener {
  return {
    async open(input) {
      await execFileAsync('git', ['push', '-u', 'origin', input.headBranch], { cwd: worktreePath });
      // Create the PR WITHOUT --reviewer. Reviewer assignment can fail for
      // reasons unrelated to the PR itself (invalid login, reviewer == PR
      // author, reviewer not a collaborator). Bundling it into `gh pr create`
      // makes `gh` exit non-zero *after* the PR is already created — which
      // would fail the whole task over a non-essential step.
      const { stdout } = await execFileAsync('gh', [
        'pr', 'create',
        '--repo', repoId,
        '--head', input.headBranch,
        '--base', input.baseBranch,
        '--title', input.title,
        '--body', input.body,
      ]);
      const url = stdout.trim();
      const match = url.match(/\/(\d+)$/);
      const number = match?.[1] ? parseInt(match[1], 10) : 0;
      // Best-effort reviewer request — never throws. A failed review request
      // must not fail an otherwise-successful PR.
      const reviewers = normalizeReviewers(input.reviewers);
      if (number > 0 && reviewers.length > 0) {
        await execFileAsync('gh', [
          'pr', 'edit', String(number),
          '--repo', repoId,
          ...reviewers.flatMap((r) => ['--add-reviewer', r]),
        ]).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[pr] reviewer request failed (non-fatal) for PR #${number}: ${msg}`);
        });
      }
      return { url, number };
    },
  };
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

async function setupWorktree(
  worktreeKey: string,
  branchName: string,
  worktreesDir: string,
  repoRoot: string,
): Promise<string> {
  const worktreePath = join(worktreesDir, `task-${worktreeKey}`);
  mkdirSync(worktreesDir, { recursive: true });

  if (existsSync(worktreePath)) {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }).catch(() => undefined);
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined);
  }

  await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot }).catch(() => undefined);
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'main'], { cwd: repoRoot });

  // Symlink the worktree's node_modules to the host repo's tree. Two
  // assumptions ride on this:
  //   1. The host install is NOT prod-stripped (devDeps like `typescript`,
  //      `tsx`, `eslint`, `@types/*` must be present, or verify steps in the
  //      pipeline fail). `deploy/deploy.sh` runs `pnpm install
  //      --frozen-lockfile` (no `--prod`) on the VPS for this reason.
  //   2. The lockfile in the worktree matches the host's. Tasks that mutate
  //      `package.json` will resolve against stale deps; the verify step
  //      (`tsc --noEmit` etc.) is the safety net that surfaces the mismatch.
  const nmTarget = join(worktreePath, 'node_modules');
  if (!existsSync(nmTarget)) {
    symlinkSync(join(repoRoot, 'node_modules'), nmTarget);
  }

  const claudeDir = join(worktreePath, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify({ permissions: WORKER_CLAUDE_PERMISSIONS }),
  );

  return worktreePath;
}

async function teardownWorktree(
  worktreeKey: string,
  branchName: string,
  worktreesDir: string,
  repoRoot: string,
): Promise<void> {
  const worktreePath = join(worktreesDir, `task-${worktreeKey}`);
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }).catch(() => undefined);
  await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined);
  await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot }).catch(() => undefined);
}
