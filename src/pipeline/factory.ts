import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { Octokit } from '@octokit/rest';
import { buildShadowObservations } from '../agents/bandit/observations.js';
import { KNOWN_MODEL_IDS } from '../agents/bandit/known-arms.js';
import { resolveRoutingModel } from '../agents/bandit/live.js';
import { setRoutingDecision } from '../agents/bandit/store-extensions.js';
import { modelToTier } from '../classifier/index.js';
import { writeRoutingDecisionLog } from '../orchestrator/closure-log.js';
import {
  decodeBridgeBrief,
  type PipelineRunBootstrap,
  type PipelineRunnerFactory,
} from '../orchestrator/pipeline-bridge.js';
import type { WorkerConfig } from '../orchestrator/types.js';
import { createIssueCommenter } from '../queue/issue-commenter.js';
import type { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { RoutingStrategy } from '@wahq/orchestrator-core/contracts/routing-strategy';
import { titleToBranchName } from '../utils/branch-name.js';
import { createVerifyRunner } from '../verify/runner.js';
import { createAccountPool, type AccountPool } from '@wahq/orchestrator-core/workers/account-pool';
import { getActivePipelineAdapter } from '@wahq/orchestrator-core/workers/adapters';
import { createDefaultRoutingStrategy } from './default-routing-strategy.js';
import { DefaultPipelineRunner } from './runner.js';
import type {
  GitOps,
  IssueCommenter,
  PipelineInput,
  PipelineResult,
  PrOpener,
  RoutingDecision,
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
    'Bash(mkdir *)',
    'Edit(*)',
    'Write(*)',
    'Read(*)',
    'Glob(*)',
    'Grep(*)',
    'TodoWrite(*)',
  ],
  deny: [
    // Each destructive subcommand listed in TWO forms: bare (no args) and
    // with-args (`*`). Claude's permission engine matches Bash patterns as
    // prefix/glob — a deny like `Bash(git push *)` matches `git push origin
    // main` but NOT bare `git push` (which pushes to the upstream default).
    // Both forms are required to cover the full mutation surface, especially
    // if an inherited or future allow widens back to `Bash(git *)`.
    'Bash(git add)',
    'Bash(git add *)',
    'Bash(git commit)',
    'Bash(git commit *)',
    'Bash(git push)',
    'Bash(git push *)',
    'Bash(git reset)',
    'Bash(git reset *)',
    'Bash(git checkout)',
    'Bash(git checkout *)',
    'Bash(git switch)',
    'Bash(git switch *)',
    'Bash(git clean)',
    'Bash(git clean *)',
    'Bash(git branch -D *)',
    'Bash(git branch -d *)',
    'Bash(git branch --delete *)',
    'Bash(git rebase)',
    'Bash(git rebase *)',
    'Bash(git merge)',
    'Bash(git merge *)',
    'Bash(git worktree *)',
    'Bash(rm)',
    'Bash(rm *)',
    'Bash(rmdir)',
    'Bash(rmdir *)',
    // `find -delete` and `find -exec rm` are well-known destructive escape
    // hatches. Denying `find` outright (rather than allowlisting the
    // read-only forms) is the simplest defence — workers can use Glob/Grep
    // for read-only discovery.
    'Bash(find)',
    'Bash(find *)',
    // Block inline code execution via `node -e`/`--eval` — these are the
    // primary escape hatches from the permission list (e.g. `node -e
    // "require('child_process').execSync('git push ...')"` would bypass
    // the git deny entries above). Legitimate node invocations go through
    // pnpm/npx scripts and don't need inline eval. Deny takes precedence
    // over the `Bash(node *)` allow above.
    'Bash(node -e *)',
    'Bash(node --eval *)',
    'Bash(sudo *)',
    'Bash(chmod *)',
    'Bash(chown *)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Bash(ssh *)',
    'Bash(scp *)',
    'Bash(mv)',
    'Bash(mv *)',
    'Bash(cp)',
    'Bash(cp *)',
  ],
} as const;

/**
 * Per-task repo resolution. The factory used to hardcode a single
 * `repoRoot`/`repoId` pair at bootstrap, which meant every task — regardless
 * of its source channel — ended up with a worktree under the IFleet checkout
 * and a PR opened against `weautomatehq1/IFleet`. A `/ship` in the factory
 * channel could plausibly mutate IFleet.
 *
 * `RepoResolver` makes the factory task-aware: it receives `task.repo`
 * (canonical `"owner/name"` string carried through the queue) and returns
 * the absolute clone path, owner/name split, base branch, and optional
 * per-repo codeowners + approver. Daemon composes the resolver from
 * `config/channels.json` (workDir, defaultBranch, codeowners) and validates
 * against `config/repos.json` (allowed repos). AUDIT-IFleet-6126a1f9.
 */
export interface ResolvedRepo {
  /** Canonical `"owner/name"` slug used by `gh pr create --repo`. */
  repoId: string;
  /** Repo owner half of the slug. */
  owner: string;
  /** Repo name half of the slug. */
  name: string;
  /** Absolute path to the canonical clone on this host. */
  repoRoot: string;
  /** Branch the PR is opened against. Per-repo so non-`main` defaults work. */
  defaultBranch: string;
  /** Optional per-repo codeowners (falls back to factory default). */
  codeowners?: ReadonlyArray<string>;
  /** Optional per-repo approver (falls back to factory default). */
  approver?: string;
}

export interface RepoResolver {
  /**
   * Resolve a task's `repo` field to its host-local clone metadata.
   * Returns `null` when the slug is not whitelisted — the factory throws on
   * null, refusing to dispatch a task that would land on the wrong repo.
   */
  resolve(repoSlug: string): ResolvedRepo | null;
  /** All known repos (used by tests + diagnostics). */
  list(): ReadonlyArray<ResolvedRepo>;
}

export interface ProductionFactoryOpts {
  repoResolver: RepoResolver;
  octokit: Octokit;
  /** Pre-built VerifyRunner; defaults to createVerifyRunner() when omitted. */
  verify?: VerifyRunner;
  /** Fallback codeowners when a resolved repo doesn't carry its own. */
  codeowners?: ReadonlyArray<string>;
  /** Fallback approver when a resolved repo doesn't carry its own. */
  approver?: string;
  initialWorkers: ReadonlyArray<WorkerConfig>;
  /**
   * TaskStore for persisting the RoutingDecision per task (M6 shadow-eval
   * substrate). When omitted, the factory skips the persistence + shadow-log
   * step entirely so existing test fixtures keep compiling without threading
   * a sqlite handle through. Live daemon wiring MUST pass this — the bandit
   * cannot learn without observations.
   */
  taskStore?: TaskStore;
  /**
   * Routing seam. When omitted, the factory falls back to
   * {@link createDefaultRoutingStrategy}, which preserves the pre-contract
   * behavior byte-for-byte (classifier → applyBanditRouting →
   * logPostRoutingDecision). Alt-orchestrators and deterministic tests can
   * inject their own strategy without stubbing bandit internals.
   */
  routingStrategy?: RoutingStrategy;
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
  const verify = opts.verify ?? buildVerifyAdapter();
  const fallbackCodeowners = opts.codeowners ?? ['@monstersebas1'];
  const fallbackApprover = opts.approver ?? '@monstersebas1';
  const routingStrategy: RoutingStrategy = opts.routingStrategy ?? createDefaultRoutingStrategy();

  let pool: AccountPool = createAccountPool(opts.initialWorkers);

  function rebuildPool(workers: ReadonlyArray<WorkerConfig>): void {
    pool = createAccountPool(workers);
  }

  const factory: PipelineRunnerFactory = async (_taskId, brief, spawnOpts): Promise<PipelineRunBootstrap> => {
    const task = decodeBridgeBrief(brief);
    if (!task) throw new Error('brief is not a structured QueuedTask payload');

    // Per-task repo resolution. Throwing here is the load-bearing safety
    // check — any task whose `repo` is not in the resolver gets refused
    // before a worktree is created, before any git command runs, and before
    // any PR is opened. The audit foot-gun was: factory channel sending a
    // task whose repo was `weautomatehq1/factory` would still build a
    // worktree under the IFleet checkout and `gh pr create` against IFleet.
    const resolved = opts.repoResolver.resolve(task.repo);
    if (!resolved) {
      const known = opts.repoResolver.list().map((r) => r.repoId).join(', ') || '(none)';
      throw new Error(
        `RepoResolver: refusing to dispatch task ${task.id} — repo "${task.repo}" ` +
          `is not in the resolver allowlist. Known repos: ${known}. ` +
          `Add it to config/channels.json or config/repos.json and reboot.`,
      );
    }

    const worktreesDir = join(resolved.repoRoot, '.omc', 'worktrees');

    const worker = pool.nextWorker();
    // Append the last 6 chars of task.id so concurrent retries for the same
    // issue never share a worktree path (AUDIT-IFleet-957ddf9e).
    const worktreeKey = task.issueNumber > 0 ? `${task.issueNumber}-${task.id.slice(-6)}` : task.id;
    const branchName = titleToBranchName(task.issueNumber > 0 ? task.issueNumber : task.id, task.title);
    const worktreePath = await setupWorktree(worktreeKey, branchName, worktreesDir, resolved.repoRoot, resolved.defaultBranch);

    const workerPool = buildWorkerPool(worker, pool, spawnOpts.parentTraceId);
    // Route classifier → bandit-live flip → closure-log through the injected
    // RoutingStrategy seam. The default strategy (installed above when opts
    // doesn't supply one) delegates to the same underlying primitives that
    // `applyBanditRouting` and `logPostRoutingDecision` below wrap — behavior
    // is byte-identical to the pre-contract call pattern. The seam exists so
    // alt-orchestrators and deterministic tests can swap in a strategy
    // without stubbing bandit internals.
    const routing = routingStrategy.classify({
      id: task.id,
      repo: task.repo,
      title: task.title,
      body: task.body,
      labels: task.labels,
      mode: task.mode ?? undefined,
    });
    // M6-T3 + AUDIT-IFleet-406c8c3e: shadow-log every role AND apply the gated
    // BANDIT_LIVE flip (a no-op while the flag is OFF — see applyBanditRouting).
    // `setRoutingDecision` runs AFTER the flip so the persisted RoutingDecision
    // is the model that actually runs (the live-flip result when ON, the
    // unchanged decision when OFF).
    if (opts.taskStore) {
      const db = opts.taskStore.getDb();
      routingStrategy.applyBanditRouting(db, routing, { id: task.id, repo: task.repo });
      setRoutingDecision(opts.taskStore, task.id, routing);
    }
    // B3 (20260618 audit): write the closure log AFTER applyBanditRouting so
    // final_tier reflects the model that actually runs. applyBanditRouting
    // mutates routing[role].model but NOT routing._meta.finalTier — derive
    // the tier from the post-bandit architect.model.
    routingStrategy.logDecision(task.id, routing);
    const abortController = new AbortController();

    const issues: IssueCommenter = createIssueCommenter(opts.octokit, resolved.owner, resolved.name);
    const pr: PrOpener = buildPrOpener(resolved.repoId, worktreePath, resolved.repoRoot);
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
      codeowners: [...(resolved.codeowners ?? fallbackCodeowners)],
      baseBranch: resolved.defaultBranch,
      approver: resolved.approver ?? fallbackApprover,
      repoRoot: resolved.repoRoot,
      reviewerMaxRounds: 3,
    };

    return {
      runner: new DefaultPipelineRunner(),
      input,
      abortController,
      workerId: worker.id,
      teardown: async (_result: PipelineResult | Error) => {
        await teardownWorktree(worktreeKey, branchName, worktreesDir, resolved.repoRoot);
      },
    };
  };

  return { factory, rebuildPool };
}

// ---------------------------------------------------------------------------
// Routing-decision closure log — emitted AFTER applyBanditRouting so the
// recorded final_tier reflects the model that actually runs (B3 from the
// 20260618-0600-codex-bugs audit).
// ---------------------------------------------------------------------------

/**
 * Emit one [ROUTING-DECISION-LOG] line for the task using the post-bandit
 * routing decision. No-op when `routing._meta` is absent.
 *
 * `final_tier` is derived from `routing.architect.model` rather than read
 * straight from `routing._meta.finalTier`: when `BANDIT_LIVE=1` the bandit
 * mutates the per-role model in place but leaves `_meta.finalTier` at the
 * classifier's original pick, so reading `_meta.finalTier` would log the
 * pre-override tier and downstream analytics would lie.
 *
 * `now` and `sink` are injectable for test determinism.
 */
export function logPostRoutingDecision(
  taskId: string,
  routing: RoutingDecision,
  now: () => string = () => new Date().toISOString(),
  sink?: (line: string) => void,
): void {
  if (!routing._meta) return;
  const finalTier = modelToTier(routing.architect.model) ?? routing._meta.finalTier;
  writeRoutingDecisionLog(
    {
      task_id: taskId,
      hit_keyword: routing._meta.hitKeyword,
      final_tier: finalTier,
      raw_score: routing._meta.rawScore,
      decided_at: now(),
    },
    sink,
  );
}

// ---------------------------------------------------------------------------
// Bandit routing seam (M6-T3 shadow-log + AUDIT-IFleet-406c8c3e live flip)
// ---------------------------------------------------------------------------

/**
 * Shadow-log the bandit's would-be pick for all three roles AND apply the
 * gated `BANDIT_LIVE` flip. Mutates `routing` IN PLACE.
 *
 * For each role, `resolveRoutingModel` always records the shadow decision
 * first (so #370 shadow logging is preserved verbatim), then:
 *   - `BANDIT_LIVE` OFF (default) ⇒ `routed.overridden === false` ⇒ `routing`
 *     is never mutated. Behavior is byte-identical to the pre-wiring
 *     shadow-only path: the live `classifyTask` decision still runs.
 *   - `BANDIT_LIVE` ON ⇒ the Thompson-sampled arm is promoted to
 *     `routing[role].model`, making the bandit's pick the actual routing
 *     decision.
 *
 * Strictly fail-open: a shadow-write/sampler hiccup (`record === null`) never
 * overrides, and a throw in one role is caught so the other roles still fire.
 *
 * `opts.live` overrides the env read (tests pass it for determinism); omit it
 * in production so the `BANDIT_LIVE` env flag is the source of truth.
 * `opts.now` injects the decision timestamp for test determinism.
 */
export function applyBanditRouting(
  db: Database.Database,
  routing: RoutingDecision,
  task: { id: string; repo: string },
  opts: { live?: boolean; now?: number } = {},
): void {
  const ROLES = ['architect', 'editor', 'reviewer'] as const;
  for (const role of ROLES) {
    try {
      const routed = resolveRoutingModel(
        db,
        {
          taskId: task.id,
          repo: task.repo,
          decidedAt: opts.now ?? Date.now(),
          actualModel: routing[role].model,
          observations: buildShadowObservations(db, task.repo, role),
          knownArms: KNOWN_MODEL_IDS,
          role,
        },
        opts.live === undefined ? {} : { live: opts.live },
      );
      // OFF ⇒ overridden is always false ⇒ no-op. ON ⇒ promote the arm.
      if (routed.overridden) {
        routing[role].model = routed.model;
      }
    } catch (err) {
      console.warn(
        `[shadow] resolveRoutingModel wiring failed for ${role} on task ${task.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal collaborator builders
// ---------------------------------------------------------------------------

export function buildWorkerPool(
  workerConfig: WorkerConfig,
  accountPool?: AccountPool,
  parentTraceId?: string,
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
        parentTraceId: parentTraceId ?? opts.parentTraceId,
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
  defaultBranch: string = 'main',
): Promise<string> {
  const worktreePath = join(worktreesDir, `task-${worktreeKey}`);
  mkdirSync(worktreesDir, { recursive: true });

  if (existsSync(worktreePath)) {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }).catch(() => undefined);
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined);
  }

  await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoRoot }).catch(() => undefined);
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, defaultBranch], { cwd: repoRoot });

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
