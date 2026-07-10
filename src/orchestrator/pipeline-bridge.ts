import type { QueuedTask as UnifiedQueuedTask } from '@wahq/orchestrator-core/contracts/task';
import type {
  PipelineInput,
  PipelineResult,
  PipelineRunner,
  QueuedTask,
} from '../pipeline/types.js';
import type {
  SpawnHandle,
  SpawnOpts,
  SpawnResult,
  TaskId,
  WorkerAdapter,
  WorkerId,
} from './types.js';

/**
 * Result returned by a {@link PipelineRunnerFactory}: a fully-wired
 * {@link PipelineRunner} plus the {@link PipelineInput} it should be invoked
 * with. Optional hooks let the bootstrap own the abort controller, the worker
 * id reported back to the orchestrator, and any cleanup (e.g. worktree
 * teardown) that should run after the pipeline finishes.
 */
export interface PipelineRunBootstrap {
  runner: PipelineRunner;
  input: PipelineInput;
  workerId?: WorkerId;
  abortController?: AbortController;
  teardown?: (result: PipelineResult | Error) => Promise<void> | void;
}

/**
 * Builds a runner + input pair for a single sprint task. Called once per
 * {@link PipelineBridge.spawn} invocation. Implementations are expected to
 * resolve the {@link QueuedTask} from the brief (typically by JSON-decoding
 * a {@link BridgeBrief}), allocate a worktree, and wire collaborators
 * (WorkerPool, IssueCommenter, PrOpener, GitOps, VerifyRunner).
 */
export type PipelineRunnerFactory = (
  taskId: TaskId,
  brief: string,
  opts: SpawnOpts,
) => Promise<PipelineRunBootstrap>;

/**
 * Envelope used when a {@link TaskRecord.brief} carries a structured task
 * payload instead of a raw markdown brief. The wire format accepts either
 * the legacy pipeline shape (GitHub-only: `issueNumber`, `body`, `labels`,
 * `autonomy`) or the unified {@link UnifiedQueuedTask} shape (any source).
 * {@link decodeBridgeBrief} normalises both shapes into the legacy pipeline
 * task type so {@link makeProductionFactory} can keep its current consumer.
 */
export interface BridgeBrief {
  kind: 'ifleet.pipeline.v1';
  task: QueuedTask | UnifiedQueuedTask;
}

export function encodeBridgeBrief(task: QueuedTask | UnifiedQueuedTask): string {
  const payload: BridgeBrief = { kind: 'ifleet.pipeline.v1', task };
  return JSON.stringify(payload);
}

/**
 * Best-effort decode of a brief written by {@link encodeBridgeBrief}. Returns
 * `undefined` if the brief is not a structured bridge payload or if the inner
 * task is missing required fields. Unified-shape payloads are converted to
 * the legacy {@link QueuedTask} shape so callers (pipeline factory) keep a
 * single internal type.
 */
export function decodeBridgeBrief(brief: string): QueuedTask | undefined {
  const trimmed = brief.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== 'ifleet.pipeline.v1'
  ) {
    return undefined;
  }
  const task = (parsed as { task?: unknown }).task;
  if (!task || typeof task !== 'object') return undefined;
  if (isUnifiedQueuedTask(task)) {
    return unifiedToPipelineTask(task as UnifiedQueuedTask);
  }
  return isValidLegacyQueuedTask(task) ? (task as QueuedTask) : undefined;
}

function isValidLegacyQueuedTask(t: object): boolean {
  const q = t as Record<string, unknown>;
  return (
    typeof q['id'] === 'string' &&
    typeof q['issueNumber'] === 'number' &&
    typeof q['repo'] === 'string' &&
    typeof q['title'] === 'string' &&
    typeof q['body'] === 'string' &&
    typeof q['autonomy'] === 'string' &&
    Array.isArray(q['labels'])
  );
}

function isUnifiedQueuedTask(t: object): boolean {
  const q = t as Record<string, unknown>;
  if (typeof q['id'] !== 'string') return false;
  if (typeof q['brief'] !== 'string') return false;
  if (typeof q['repo'] !== 'string') return false;
  if (typeof q['title'] !== 'string') return false;
  const source = q['source'];
  if (typeof source !== 'object' || source === null) return false;
  const kind = (source as { kind?: unknown }).kind;
  return kind === 'github' || kind === 'discord';
}

function unifiedToPipelineTask(task: UnifiedQueuedTask): QueuedTask {
  const issueNumber = task.source.kind === 'github' ? task.source.issueNumber : 0;
  const autonomy = task.routingHints?.autonomy ?? 'auto';
  return {
    id: task.id,
    issueNumber,
    repo: task.repo,
    title: task.title,
    body: task.brief,
    autonomy,
    labels: [],
    // Propagate per-task mode unconditionally (including explicit `null`) so
    // operators can pin "no mode" via Discord slash-command. Without this, an
    // explicit `mode:ralph` on a unified-shape brief silently degraded to the
    // standard prompt. Closes AUDIT-IFleet-88fe0722 / AUDIT-IFleet-33c47c45.
    mode: task.mode ?? null,
  };
}

/**
 * Adapts {@link PipelineRunner} (the Architect → Editor → Reviewer pipeline)
 * to the {@link WorkerAdapter} interface so {@link SprintManager} can drive a
 * full pipeline run instead of a raw worker spawn. Each `spawn()` call invokes
 * the factory, runs the pipeline, and maps {@link PipelineResult.status} →
 * {@link SpawnResult.exitCode}: `0`=pr_opened, `1`=failed, `2`=cancelled, `3`=blocked_by_reviewer.
 */
export class PipelineBridge implements WorkerAdapter {
  constructor(private readonly factory: PipelineRunnerFactory) {}

  async spawn(taskId: TaskId, brief: string, opts: SpawnOpts): Promise<SpawnHandle> {
    const bootstrap = await this.factory(taskId, brief, opts);
    const workerId = bootstrap.workerId ?? 'pipeline';
    const abortController = bootstrap.abortController;

    if (!abortController) {
      console.warn(`[PipelineBridge] taskId=${taskId} — no abortController in bootstrap; cancellation will be a no-op`);
    }

    const done = this.execute(taskId, workerId, bootstrap);

    return {
      workerId,
      taskId,
      done,
      cancel: async () => {
        abortController?.abort();
        await done.catch(() => undefined);
      },
    };
  }

  private async execute(
    taskId: TaskId,
    workerId: WorkerId,
    bootstrap: PipelineRunBootstrap,
  ): Promise<SpawnResult> {
    let outcome: PipelineResult | Error;
    try {
      const result = await bootstrap.runner.run(bootstrap.input);
      outcome = result;
      return mapPipelineResult(result, taskId, workerId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      outcome = error;
      console.error('[pipeline-bridge] execute threw:', error.message, error.stack);
      return {
        taskId,
        workerId,
        exitCode: 1,
        error: error.message,
      };
    } finally {
      if (bootstrap.teardown) {
        try {
          await bootstrap.teardown(outcome!);
        } catch {
          // teardown errors must not mask the pipeline result
        }
      }
    }
  }
}

function mapPipelineResult(
  result: PipelineResult,
  taskId: TaskId,
  workerId: WorkerId,
): SpawnResult {
  const exitCode = statusToExitCode(result.status);
  const spawnResult: SpawnResult = { taskId, workerId, exitCode };
  if (result.prUrl) spawnResult.pr = result.prUrl;
  if (exitCode !== 0) {
    spawnResult.error = result.failureReason ?? result.status;
  }
  if (result.totalTokens) spawnResult.totalTokens = result.totalTokens;
  const totalCostUsd = sumAttemptCost(result);
  // Preserve zero-vs-missing: only set the field when a cost was actually
  // reported. A genuine 0 (all reporting workers were free) is propagated;
  // "no worker reported cost" stays undefined so SprintManager treats it as
  // unknown rather than free.
  if (totalCostUsd !== undefined) spawnResult.totalCostUsd = totalCostUsd;
  return spawnResult;
}

/**
 * Aggregate the per-attempt USD cost for a pipeline run, preserving the
 * "zero vs missing" distinction. {@link PipelineResult} has no top-level cost
 * field today (only `totalTokens`), so the real spend lives on each
 * {@link AttemptRecord.totalCostUsd}, populated from the worker's
 * `SpawnResult.totalCostUsd`. Returns `undefined` when NO attempt reported a
 * cost (workers like Codex don't surface USD — treat as "unknown", not "free")
 * and the sum of the reported values otherwise — which may be a genuine `0`.
 *
 * Without this, `mapPipelineResult` left `SpawnResult.totalCostUsd` undefined,
 * so `SprintManager.accumulateCost` (sprint.ts) never advanced the running
 * total and the `BUDGET_USD` cap could never fire. Closes
 * AUDIT-IFleet-25b947c4 / AUDIT-IFleet-9e154efd.
 */
function sumAttemptCost(result: PipelineResult): number | undefined {
  // Future-proofing: honour an aggregate field if the pipeline ever sets one
  // on PipelineResult directly (mirrors how `totalTokens` is surfaced).
  const aggregate = (result as { totalCostUsd?: number }).totalCostUsd;
  if (typeof aggregate === 'number') return aggregate;
  let sum = 0;
  let sawCost = false;
  for (const attempt of result.attempts) {
    if (typeof attempt.totalCostUsd === 'number') {
      sawCost = true;
      sum += attempt.totalCostUsd;
    }
  }
  return sawCost ? sum : undefined;
}

function statusToExitCode(status: PipelineResult['status']): number {
  switch (status) {
    case 'pr_opened': return 0;
    case 'already_resolved': return 0;
    case 'failed': return 1;
    case 'cancelled': return 2;
    case 'blocked_by_reviewer': return 3;
    case 'awaiting_interview': return 4;
    // Defensive default: a future status value added without updating this
    // switch must NOT return `undefined`, which would make SpawnResult.exitCode
    // unswitchable in the sprint handler and silently strand the task. Treat
    // unknown as a generic failure (exit 1). Closes AUDIT-IFleet-cac2e1f6.
    default: return 1;
  }
}
