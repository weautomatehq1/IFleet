// PR decision tracking, verifier context registry, and pipeline factory wrappers.
// Extracted from daemon.ts — pure structural refactor, no logic changes.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import type { TaskRunContext } from '../../agents/verifier/controller.js';
import { computeStructuralFingerprint } from '../../agents/verifier/fingerprint.js';
import { broadcastIFleet } from '../../observability/discord-broadcast.js';
import { DiscordOutAdapter } from '../../observability/discord-output.js';
import type { PipelineRunBootstrap, PipelineRunnerFactory } from '../pipeline-bridge.js';
import { decodeBridgeBrief } from '../pipeline-bridge.js';
import type { PipelineEvent } from '../../pipeline/types.js';
import { StateStore } from '../store.js';
import { TaskStore } from '../../queue/store.js';
import { ControlPlaneApprovalGate } from '../approval-gate.js';
import type { SprintId, TaskId } from '../types.js';
import type { QueuedTask } from '../../contracts/task.js';
import { titleToBranchName } from '../../utils/branch-name.js';

const execFileAsync = promisify(execFile);

interface TaskContextRecord {
  repoUrl: string;
  branch: string;
  worktreePath: string;
  sha?: string;
  // M4-T6: cached structural fingerprint computed at teardown time, while
  // the worktree still exists. Read at sprint.completed/failed/cancelled
  // event time (after the worktree is gone). `null` means compute was
  // attempted and failed; `undefined` means it never ran (treat as null).
  fingerprint?: string | null;
}

export class TaskContextRegistry {
  // Records are stored once under a primary key (the orchestrator's `tk_*`
  // task ID) and exposed via secondary aliases (the unified queue ID — Discord
  // ULID or GitHub node_id). `get`/`setSha`/`delete` resolve aliases first so
  // either ID namespace returns the same record. Closes AUDIT-IFleet-57f5d4e8.
  private readonly map = new Map<string, TaskContextRecord>();
  private readonly aliasToPrimary = new Map<string, string>();

  record(taskId: string, rec: TaskContextRecord, alias?: string): void {
    this.map.set(taskId, rec);
    if (alias && alias !== taskId) this.aliasToPrimary.set(alias, taskId);
  }
  setSha(taskId: string, sha: string): void {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const r = this.map.get(primary);
    if (r) r.sha = sha;
  }
  /**
   * M4-T6: stash the structural fingerprint that {@link wrapFactoryWithVerifierContext}'s
   * teardown wrapper computed against the live worktree. Resolves aliases like
   * setSha. Setting `null` is meaningful: it records "compute was attempted and
   * failed", which lets the wiring layer distinguish from `undefined` (the
   * teardown hook never ran — e.g. a synthetic test setup).
   */
  setFingerprint(taskId: string, fingerprint: string | null): void {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const r = this.map.get(primary);
    if (r) r.fingerprint = fingerprint;
  }
  get(taskId: string): TaskContextRecord | undefined {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    return this.map.get(primary);
  }
  /**
   * Evict on terminal sprint state. Without this the map grows monotonically
   * for the life of the 24/7 daemon — every processed task adds one entry
   * that's never reclaimed. AUDIT-IFleet-4aed4b1e / 8c9e1b6f / 3d7f47c3 / 4c20a0e6.
   *
   * Accepts either the primary `tk_*` ID or any alias — removes the record
   * and every alias pointing at it.
   */
  delete(taskId: string): boolean {
    const primary = this.aliasToPrimary.get(taskId) ?? taskId;
    const existed = this.map.delete(primary);
    for (const [alias, target] of this.aliasToPrimary.entries()) {
      if (target === primary) this.aliasToPrimary.delete(alias);
    }
    return existed;
  }
  /** Test helper — current entry count (primary keys only). */
  size(): number { return this.map.size; }
}

export function wrapFactoryWithVerifierContext(
  inner: PipelineRunnerFactory,
  registry: TaskContextRegistry,
): PipelineRunnerFactory {
  return async (taskId, brief, opts): Promise<PipelineRunBootstrap> => {
    const bootstrap = await inner(taskId, brief, opts);
    const task = decodeBridgeBrief(brief);
    if (task) {
      // Alias the unified queue ID (Discord ULID / GitHub node_id) to the
      // orchestrator's `tk_*` primary key so callbacks that arrive with the
      // unified ID (onForcePr, wireSprintCompletion's verifierCtx.delete) can
      // resolve the same record. AUDIT-IFleet-57f5d4e8.
      registry.record(
        taskId,
        {
          repoUrl: `https://github.com/${task.repo}`,
          branch: titleToBranchName(task.issueNumber, task.title),
          worktreePath: bootstrap.input.worktreePath,
        },
        task.id,
      );
    }
    const origTeardown = bootstrap.teardown;
    // Capture HEAD SHA AND structural fingerprint before the inner teardown
    // removes the worktree. wireSprintCompletion reads both at sprint.completed
    // /failed/cancelled time, but those events fire AFTER teardown — so the
    // compute MUST happen here, while the worktree still exists. M4-T6.
    bootstrap.teardown = async (result) => {
      let headSha: string | null = null;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: bootstrap.input.worktreePath,
        });
        headSha = stdout.trim();
        registry.setSha(taskId, headSha);
      } catch { /* missing worktree → resolver returns null, verifier skips */ }
      if (headSha) {
        try {
          // baseRef='main' is safe: production worktrees are always created from main
          // by buildWorkerPool (factory.ts:324 `git worktree add ... main`). AUDIT-IFleet-0c47bae9.
          const fp = await computeStructuralFingerprint({
            repoRoot: bootstrap.input.worktreePath,
            baseRef: 'main',
            headRef: headSha,
          });
          registry.setFingerprint(taskId, fp.sha256);
        } catch (err) {
          console.warn('[daemon] teardown-time computeStructuralFingerprint failed:', err);
          console.warn('[daemon] teardown-time fingerprint=null for task ' + taskId + ' (baseRef=main, headSha=' + headSha + ')');
          registry.setFingerprint(taskId, null);
        }
      } else {
        console.warn('[daemon] teardown-time fingerprint=null for task ' + taskId + ' (baseRef=main, headSha=unknown)');
        registry.setFingerprint(taskId, null);
      }
      if (origTeardown) await origTeardown(result);
    };
    return bootstrap;
  };
}

/**
 * Dependencies for {@link handleForcePr}. `execFile` and `broadcast` default
 * to the module-level production wiring; tests inject stubs.
 */
export interface ForcePrDeps {
  store: TaskStore;
  orchestratorStore: StateStore;
  unifiedToSprintId: Map<string, SprintId>;
  verifierCtx: TaskContextRegistry;
  octokit: Pick<Octokit, 'rest'>;
  execFile?: typeof execFileAsync;
  broadcast?: (msg: string) => void;
}

type ForcePrPushOutcome = 'success' | 'already-up-to-date' | 'failed';

/**
 * Operator override handler. Logs the deliberate verifier bypass into the
 * events table, pushes the task's branch to origin, and opens a PR via the
 * Octokit client.
 *
 * Push outcomes (AUDIT-IFleet-c9d0e1f2):
 *   - success: branch pushed, proceed to pulls.create
 *   - already-up-to-date: branch already at this SHA on origin (benign,
 *     git exits 0 with "Everything up-to-date"), proceed to pulls.create
 *   - failed: real push error (auth, network, branch protection, worktree
 *     gone) — abort the force-PR and tell the operator via broadcastIFleet.
 *     Do NOT call pulls.create, which would emit a misleading "PR may
 *     already exist" message when the real cause is upstream of PR creation
 *     entirely.
 *
 * Extracted from the inline onForcePr callback so the push-outcome branches
 * can be exercised in unit tests without booting the daemon.
 */
export async function handleForcePr(
  taskId: string,
  reason: string | undefined,
  deps: ForcePrDeps,
): Promise<void> {
  const {
    store,
    orchestratorStore,
    unifiedToSprintId,
    verifierCtx,
    octokit,
    execFile = execFileAsync,
    broadcast = broadcastIFleet,
  } = deps;
  let sprintId: SprintId | undefined;
  try {
    const unified = store.getById(taskId);
    sprintId = unifiedToSprintId.get(taskId);
    if (sprintId) {
      orchestratorStore.appendEvent({
        ts: Date.now(),
        sprintId,
        taskId: taskId as TaskId,
        kind: 'verifier.force_pr',
        payload: { reason: reason ?? null },
      });
    } else {
      const tk = orchestratorStore.loadTask(taskId as TaskId);
      if (tk) {
        sprintId = tk.sprintId;
        orchestratorStore.appendEvent({
          ts: Date.now(),
          sprintId: tk.sprintId,
          taskId: tk.id,
          kind: 'verifier.force_pr',
          payload: { reason: reason ?? null },
        });
      }
    }
    const ctx = verifierCtx.get(taskId);
    if (!ctx) {
      console.warn(
        `[daemon] onForcePr(${taskId}): no branch context in TaskContextRegistry — audit event logged but PR not opened`,
      );
      return;
    }
    const repoSlug = ctx.repoUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const [owner, repo] = repoSlug.split('/', 2);
    if (!owner || !repo) {
      console.warn(
        `[daemon] onForcePr(${taskId}): could not parse owner/repo from ${ctx.repoUrl}`,
      );
      return;
    }
    const title = unified?.title ?? `Force-PR for ${taskId}`;
    const body =
      `Force-PR override dispatched via Discord.\n\n` +
      `- Task: \`${taskId}\`\n` +
      `- Reason: \`${(reason ?? '(none)').replace(/`/g, "'")}\`\n` +
      `- Verifier status: \`failed\` (deliberate operator bypass)\n`;
    // Push the branch first — onForcePr can fire from a failed-verifier
    // worktree that the normal PR path never reached, so origin may not
    // have the head yet. Three outcomes:
    //   - success: branch pushed, proceed to pulls.create
    //   - already-up-to-date: branch already at this SHA on origin (benign),
    //     proceed to pulls.create
    //   - failed: real push error (auth, network, branch protection, worktree
    //     gone) — abort the force-PR and tell the operator. Do NOT call
    //     pulls.create, which would emit a misleading "PR may already exist"
    //     message when the real cause is upstream of PR creation entirely.
    // (AUDIT-IFleet-c9d0e1f2 closed by this change.)
    let pushOutcome: ForcePrPushOutcome = 'success';
    let pushErrorMessage = '';
    try {
      const { stdout, stderr } = await execFile(
        'git',
        ['push', '-u', 'origin', ctx.branch],
        { cwd: ctx.worktreePath },
      );
      if (
        /Everything up-to-date/i.test(stderr ?? '') ||
        /Everything up-to-date/i.test(stdout ?? '')
      ) {
        pushOutcome = 'already-up-to-date';
      }
    } catch (pushErr) {
      pushOutcome = 'failed';
      pushErrorMessage = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.warn(
        `[daemon] onForcePr(${taskId}): git push failed, aborting force-PR: ${pushErrorMessage}`,
      );
    }
    if (pushOutcome === 'failed') {
      if (sprintId) {
        try {
          orchestratorStore.appendEvent({
            ts: Date.now(),
            sprintId,
            taskId: taskId as TaskId,
            kind: 'verifier.force_pr_aborted',
            payload: { reason: reason ?? null, cause: 'push_failed', error: pushErrorMessage },
          });
        } catch (err) {
          console.warn('[daemon] onForcePr abort event append failed:', err);
        }
      }
      const abortMsg =
        `⛔ /force-pr ABORTED — \`${taskId}\` — \`git push origin ${ctx.branch}\` failed; PR NOT opened. ` +
        `Reason: \`${(reason ?? '(none)').replace(/`/g, "'")}\`. ` +
        `Recovery: investigate push failure (auth, network, branch protection, worktree state), then retry /force-pr if appropriate. ` +
        `Push error: ${pushErrorMessage || '(no message)'}`;
      try {
        broadcast(abortMsg);
      } catch (err) {
        console.warn('[daemon] onForcePr abort broadcast failed:', err);
      }
      return;
    }
    // Use the existing Octokit client (already authenticated with
    // GITHUB_TOKEN) instead of shelling to `gh`, which isn't installed on
    // the VPS daemon image. AUDIT-IFleet-63347c06.
    try {
      await octokit.rest.pulls.create({
        owner,
        repo,
        base: 'main',
        head: ctx.branch,
        title,
        body,
      });
    } catch (err) {
      console.warn(
        `[daemon] onForcePr(${taskId}): pulls.create failed (PR may already exist): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } catch (err) {
    console.warn('[daemon] onForcePr append failed:', err);
  }
}

/**
 * Read the structural fingerprint that {@link wrapFactoryWithVerifierContext}'s
 * teardown wrapper cached on the registry. M4-T6 moved the compute upstream
 * because the worktree is gone by the time sprint.completed/failed/cancelled
 * fires — recomputing here would always return null in production. The
 * graceful-failure contract carries over: a missing ctx, an unset fingerprint
 * (teardown hook never ran), or a recorded `null` (compute attempted and
 * failed) all flow through as `null` so the caller still inserts the row
 * with verdict + fingerprint=null.
 */
function readCachedFingerprint(
  ctx: { fingerprint?: string | null } | undefined,
): string | null {
  return ctx?.fingerprint ?? null;
}

export function recordPrDecisionMerged(
  store: TaskStore,
  task: QueuedTask,
  prNumber: number,
  ctx: { fingerprint?: string | null } | undefined,
): void {
  const fingerprint = readCachedFingerprint(ctx);
  try {
    store.insertPrDecisionWithFingerprint({
      id: `prd_${randomUUID()}`,
      taskId: task.id,
      repo: task.repo,
      prNumber,
      verdict: 'merged',
      reviewerLogin: null,
      mergedAt: Date.now(),
      fingerprint,
    });
  } catch (err) {
    console.warn('[daemon] insertPrDecisionWithFingerprint(merged) failed:', err);
  }
}

export function recordPrDecisionRejected(
  store: TaskStore,
  task: QueuedTask,
  prNumber: number,
  ctx: { fingerprint?: string | null } | undefined,
): void {
  const fingerprint = readCachedFingerprint(ctx);
  try {
    store.insertPrDecisionWithFingerprint({
      id: `prd_${randomUUID()}`,
      taskId: task.id,
      repo: task.repo,
      prNumber,
      verdict: 'rejected',
      reviewerLogin: null,
      fingerprint,
    });
  } catch (err) {
    console.warn('[daemon] insertPrDecisionWithFingerprint(rejected) failed:', err);
  }
}

export async function resolveVerifierContext(
  taskId: TaskId,
  registry: TaskContextRegistry,
  store: StateStore,
): Promise<TaskRunContext | null> {
  const rec = registry.get(taskId);
  const task = store.loadTask(taskId);
  if (!rec || !task || !rec.sha) return null;
  return {
    taskId,
    sprintId: task.sprintId,
    repoUrl: rec.repoUrl,
    branch: rec.branch,
    sha: rec.sha,
    worktreePath: rec.worktreePath,
    attempt: 1,
  };
}

/**
 * Wrap a production PipelineRunnerFactory so the architect can route plan +
 * approval through Discord. Mutates `bootstrap.input` to inject the
 * ApprovalGate and the onArchitectPlan callback before returning.
 */
export function wrapFactoryWithApprovalAndEmit(
  inner: PipelineRunnerFactory,
  approvalGate: ControlPlaneApprovalGate,
  onPlan: (taskId: string, plan: string) => Promise<void>,
  emitPipelineEvent?: (taskId: string, event: PipelineEvent) => void,
): PipelineRunnerFactory {
  return async (taskId, brief, opts): Promise<PipelineRunBootstrap> => {
    const bootstrap = await inner(taskId, brief, opts);
    bootstrap.input.approvalGate = approvalGate;
    bootstrap.input.onArchitectPlan = async (plan) => {
      await onPlan(taskId, plan);
    };
    // Wire the pipeline's structured event stream into the orchestrator's
    // event log. Without this, reviewer.rejected (issue #163),
    // plan_reviewer.vetoed/escalated/skipped, and reviewer.haiku_gate_passed
    // are emitted into `undefined?.()` and silently dropped. The translation
    // to OrchestratorEvent happens in main() where the StateStore lives.
    if (emitPipelineEvent) {
      bootstrap.input.eventSink = (event) => {
        try {
          emitPipelineEvent(taskId, event);
        } catch (err) {
          // Per PipelineInput contract: failures inside the sink must not
          // affect the pipeline result. Log and continue.
          console.warn('[daemon] pipeline event sink threw:', err);
        }
      };
    }
    return bootstrap;
  };
}

/**
 * Translate a {@link PipelineEvent} into the orchestrator's {@link OrchestratorEvent}
 * envelope and append to the events table. The sprintId is resolved from the
 * orchestrator store via `loadTask(taskId).sprintId`; if the task lookup fails
 * (race during teardown, store closed), the event is dropped with a warn —
 * the pipeline result is unaffected.
 *
 * This is the missing half of issue #163: PR #166 added the `reviewer.rejected`
 * event but the runner emits it into `input.eventSink?.()` which was `undefined`
 * in production. This persists it (and three sibling events that were also
 * being dropped: `plan_reviewer.vetoed/escalated/skipped`, `reviewer.haiku_gate_passed`).
 */
export function persistPipelineEvent(
  store: StateStore,
  taskId: string,
  event: PipelineEvent,
): void {
  const task = store.loadTask(taskId as TaskId);
  if (!task) {
    console.warn(
      `[daemon] persistPipelineEvent: task ${taskId} not found in state store; dropping event ${event.kind}`,
    );
    return;
  }
  // Strip kind+taskId from the payload — they live on the envelope. Cast via
  // `unknown` because the discriminated-union payload shape varies per kind.
  const { kind: _kind, taskId: _taskId, ...payload } = event as unknown as Record<string, unknown> & {
    kind: string;
    taskId: string;
  };
  store.appendEvent({
    ts: Date.now(),
    sprintId: task.sprintId,
    taskId: task.id,
    kind: event.kind,
    payload,
  });
}

/**
 * Bridge from the architect's plan-ready hook to the per-task Discord
 * thread. Looks up the unified task to find the threadId (Discord-source)
 * or skip silently (GitHub-source — handled via issue commenter).
 */
export async function discordOutPlanReady(
  taskId: string,
  plan: string,
  store: TaskStore,
  out: DiscordOutAdapter,
): Promise<void> {
  const task: QueuedTask | null = store.getById(taskId);
  if (!task) return;
  if (task.source.kind !== 'discord') return;
  const threadId = task.source.threadId;
  if (!threadId) return;
  await out.postPlanForApproval(threadId, plan);
}
