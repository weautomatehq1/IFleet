/**
 * VerifierController — subscribes to `task.completed` from SprintManager,
 * orchestrates the closed-loop verification (sandbox + invariants), persists
 * verifier_runs / verifier_failures, and emits `verifier.{passed,failed,
 * timeout,error}` back into the same trace.
 *
 * This is the M1.W2 "wiring point" the scaffold docstring referenced. It is
 * intentionally a thin, externally-attached subscriber so SprintManager
 * itself does not need to change (per T2 boundary notes).
 *
 * Manual rerun entry point: {@link VerifierController.verifyManual} is what
 * the Discord `/verify <taskId>` handler calls.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { StateStore } from '../../orchestrator/store.js';
import type {
  OrchestratorEvent,
  SprintId,
  TaskId,
} from '../../orchestrator/types.js';
import { InvariantRunner } from './invariants.js';
import { DockerSandboxRunner, type SandboxRunner } from './sandbox.js';
import { VerifierStoreBridge } from './store-bridge.js';
import type {
  VerifierFailure,
  VerifierRunInput,
  VerifierRunResult,
} from './types.js';
import { newVerifierRunId } from './types.js';

export interface VerifierControllerOptions {
  store: StateStore;
  emit: (event: OrchestratorEvent) => void;
  sandbox?: SandboxRunner;
  invariants?: InvariantRunner;
  /** Resolves a taskId to its repoUrl/branch/sha/worktree. Tests stub this. */
  resolveTaskContext: (
    taskId: TaskId,
  ) => Promise<TaskRunContext | null>;
  /** Repo slug used to locate `.ifleet/invariants/<slug>/`. Defaults to `default`. */
  repoSlug?: string;
  /** Root for `.ifleet/invariants/` lookups. Defaults to process.cwd(). */
  invariantsRoot?: string;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TaskRunContext {
  taskId: TaskId;
  sprintId: SprintId;
  repoUrl: string;
  branch: string;
  sha: string;
  worktreePath?: string;
  attempt: number;
}

export class VerifierController {
  private readonly store: StateStore;
  private readonly bridge: VerifierStoreBridge;
  private readonly emit: (event: OrchestratorEvent) => void;
  private readonly sandbox: SandboxRunner;
  private readonly invariants: InvariantRunner;
  private readonly resolveTaskContext: VerifierControllerOptions['resolveTaskContext'];
  private readonly repoSlug: string;
  private readonly invariantsRoot: string | undefined;
  private readonly now: () => number;
  private readonly log: VerifierControllerOptions['log'];

  constructor(opts: VerifierControllerOptions) {
    this.store = opts.store;
    this.bridge = new VerifierStoreBridge(this.store);
    this.emit = opts.emit;
    this.sandbox = opts.sandbox ?? new DockerSandboxRunner();
    this.invariants = opts.invariants ?? new InvariantRunner();
    this.resolveTaskContext = opts.resolveTaskContext;
    this.repoSlug = opts.repoSlug ?? 'default';
    this.invariantsRoot = opts.invariantsRoot;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
  }

  /**
   * Event-bus handler — attach via `orchestrator.on('event', controller.onEvent)`.
   * Filters to `task.completed` and ignores everything else.
   */
  readonly onEvent = (event: OrchestratorEvent): void => {
    if (event.kind !== 'task.completed') return;
    if (!event.taskId) return;
    void this.verifyTask(event.taskId).catch((err) => {
      this.log?.(`verifier controller failed for ${event.taskId}: ${asMessage(err)}`);
    });
  };

  /**
   * Manual rerun entry point used by the Discord `/verify <taskId>` slash
   * command. Always increments attempt by 1 above the latest persisted run
   * (or starts at 1 if there is none).
   */
  async verifyManual(taskId: TaskId): Promise<VerifierRunResult | { error: string }> {
    const ctx = await this.resolveTaskContext(taskId);
    if (!ctx) return { error: `task ${taskId} not found` };
    const prior = this.bridge.listRunsByTask(taskId);
    const attempt = prior.length === 0 ? 1 : Math.max(...prior.map((r) => r.attempt)) + 1;
    return this.runVerification({ ...ctx, attempt });
  }

  /** Programmatic entry point used by the auto subscription handler. */
  async verifyTask(taskId: TaskId): Promise<VerifierRunResult | null> {
    const ctx = await this.resolveTaskContext(taskId);
    if (!ctx) {
      this.log?.(`verifier: skipping ${taskId} — no run context`);
      return null;
    }
    return this.runVerification(ctx);
  }

  private async runVerification(ctx: TaskRunContext): Promise<VerifierRunResult> {
    const startedAt = this.now();
    const runId = newVerifierRunId(randomUUID());
    this.bridge.insertRun({
      runId,
      taskId: ctx.taskId,
      sprintId: ctx.sprintId,
      repoUrl: ctx.repoUrl,
      branch: ctx.branch,
      sha: ctx.sha,
      attempt: ctx.attempt,
      startedAt,
    });
    this.emit({
      ts: startedAt,
      sprintId: ctx.sprintId,
      taskId: ctx.taskId,
      kind: 'verifier.started',
      payload: { runId, attempt: ctx.attempt },
    });

    let sandboxResult: VerifierRunResult;
    try {
      const input: VerifierRunInput = {
        taskId: ctx.taskId,
        sprintId: ctx.sprintId,
        repoUrl: ctx.repoUrl,
        branch: ctx.branch,
        sha: ctx.sha,
        attempt: ctx.attempt,
        ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
      };
      sandboxResult = await this.sandbox.run(input);
    } catch (err) {
      const finishedAt = this.now();
      const result: VerifierRunResult = {
        runId,
        status: 'error',
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        attempt: ctx.attempt,
        failures: [{ kind: 'install', message: `sandbox threw: ${asMessage(err)}` }],
        phases: [],
      };
      this.bridge.completeRun(result);
      this.emit({
        ts: finishedAt,
        sprintId: ctx.sprintId,
        taskId: ctx.taskId,
        kind: 'verifier.error',
        payload: { runId, error: asMessage(err) },
      });
      return result;
    }

    // Run invariants on top of the sandbox result so they can be cached
    // independently and easily reused for `/verify --invariants-only`.
    const invariantFailures = await this.runInvariants(ctx);
    const merged = mergeInvariantFailures(sandboxResult, invariantFailures, runId, this.now());
    this.bridge.completeRun(merged);
    this.emit({
      ts: merged.finishedAt,
      sprintId: ctx.sprintId,
      taskId: ctx.taskId,
      kind: statusToEventKind(merged.status),
      payload: serializeResult(merged),
    });
    return merged;
  }

  private async runInvariants(ctx: TaskRunContext): Promise<VerifierFailure[]> {
    if (!ctx.worktreePath || !existsSync(ctx.worktreePath)) return [];
    try {
      const opts: { worktreePath: string; repoSlug: string; invariantsRoot?: string } = {
        worktreePath: ctx.worktreePath,
        repoSlug: this.repoSlug,
      };
      if (this.invariantsRoot) opts.invariantsRoot = this.invariantsRoot;
      return await this.invariants.run(opts);
    } catch (err) {
      return [{ kind: 'invariant', message: `invariant runner threw: ${asMessage(err)}` }];
    }
  }
}

function mergeInvariantFailures(
  sandboxResult: VerifierRunResult,
  invariantFailures: VerifierFailure[],
  runId: ReturnType<typeof newVerifierRunId>,
  now: number,
): VerifierRunResult {
  const failures = [...sandboxResult.failures, ...invariantFailures];
  const merged: VerifierRunResult = {
    ...sandboxResult,
    runId,
    failures,
    finishedAt: now,
    durationMs: now - sandboxResult.startedAt,
  };
  if (sandboxResult.status === 'passed' && invariantFailures.length > 0) {
    merged.status = 'failed';
  }
  return merged;
}

function statusToEventKind(status: VerifierRunResult['status']): string {
  switch (status) {
    case 'passed':
      return 'verifier.passed';
    case 'failed':
      return 'verifier.failed';
    case 'timeout':
      return 'verifier.timeout';
    case 'error':
      return 'verifier.error';
    case 'partial':
      // `partial` is a green-with-banner result: tests skipped because the
      // repo had no test script. PR still opens, label `verified: partial`.
      return 'verifier.passed';
  }
}

function serializeResult(result: VerifierRunResult): Record<string, unknown> {
  return {
    runId: result.runId,
    status: result.status,
    attempt: result.attempt,
    durationMs: result.durationMs,
    failures: result.failures,
    phases: result.phases ?? [],
    rawLogUrl: result.rawLogUrl,
    banner: result.banner,
    costUsd: result.costUsd,
  };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
