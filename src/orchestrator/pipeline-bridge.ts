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
 * Envelope used when a {@link TaskRecord.brief} carries a structured
 * {@link QueuedTask} payload instead of a raw markdown brief. The bridge
 * helper {@link decodeBridgeBrief} extracts the task; factories may use it
 * directly or roll their own format.
 */
export interface BridgeBrief {
  kind: 'ifleet.pipeline.v1';
  task: QueuedTask;
}

export function encodeBridgeBrief(task: QueuedTask): string {
  const payload: BridgeBrief = { kind: 'ifleet.pipeline.v1', task };
  return JSON.stringify(payload);
}

/**
 * Best-effort decode of a brief written by {@link encodeBridgeBrief}. Returns
 * `undefined` if the brief is not a structured bridge payload, letting the
 * caller fall back to treating the brief as a raw issue body.
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
  return task as QueuedTask;
}

/**
 * Adapts {@link PipelineRunner} (the Architect → Editor → Reviewer pipeline)
 * to the {@link WorkerAdapter} interface so {@link SprintManager} can drive a
 * full pipeline run instead of a raw worker spawn. Each `spawn()` call invokes
 * the factory, runs the pipeline, and maps {@link PipelineResult.status} →
 * {@link SpawnResult.exitCode} (`0` for `pr_opened`, `1` otherwise).
 */
export class PipelineBridge implements WorkerAdapter {
  constructor(private readonly factory: PipelineRunnerFactory) {}

  async spawn(taskId: TaskId, brief: string, opts: SpawnOpts): Promise<SpawnHandle> {
    const bootstrap = await this.factory(taskId, brief, opts);
    const workerId = bootstrap.workerId ?? 'pipeline';
    const abortController = bootstrap.abortController;

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
  const exitCode = result.status === 'pr_opened' ? 0 : 1;
  const spawnResult: SpawnResult = { taskId, workerId, exitCode };
  if (result.prUrl) spawnResult.pr = result.prUrl;
  if (exitCode !== 0) {
    spawnResult.error = result.failureReason ?? result.status;
  }
  return spawnResult;
}
