/**
 * Retry orchestrator — owns the verifier.failed → editor.retry feedback loop.
 *
 * Listens (via {@link wireRetryLoop}) for `verifier.failed` events emitted by
 * the VerifierController. When the failed run is still under
 * MAX_VERIFIER_ATTEMPTS, it re-queues the editor with structured feedback by
 * submitting a single-task sprint to the SprintManager. Above the cap, it
 * surfaces the failure to Discord with `[Retry] [Force-PR] [Cancel]` buttons.
 *
 * The retry submission re-uses the original task brief verbatim and prepends a
 * fenced `## Verifier feedback (attempt N)` section so the architect/editor
 * persona sees the exact failure lines. The pipeline classifier already
 * extracts `mode:` headers from the body, so the retry brief carries forward
 * any explicit mode pin from the operator.
 */

import type { ControlPlaneClient } from '../../contracts/control-plane-client.js';
import type {
  OrchestratorEvent,
  SprintId,
  TaskId,
} from '../../orchestrator/types.js';
import { MAX_VERIFIER_ATTEMPTS } from './index.js';
import type { VerifierFailure } from './types.js';

export interface RetryOrchestratorDeps {
  /** Resolves a taskId → original brief so the retry submission has context. */
  loadOriginalBrief: (taskId: TaskId) => Promise<string | null>;
  /**
   * Submits a new single-task sprint carrying the retry brief. The controller
   * already validates `attempt < MAX_VERIFIER_ATTEMPTS` before calling, so the
   * implementation can assume the resubmission is allowed.
   */
  submitRetrySprint: (args: {
    originalTaskId: TaskId;
    retryAttempt: number;
    brief: string;
  }) => Promise<{ sprintId: SprintId; taskId: TaskId }>;
  /** Posts the failure surface (structured failures + action buttons) to Discord. */
  postFailureSurface: (args: {
    taskId: TaskId;
    attempt: number;
    failures: ReadonlyArray<VerifierFailure>;
    rawLogUrl: string | undefined;
    /** True when this is the final attempt — Discord rendering changes copy. */
    exhausted: boolean;
  }) => Promise<void>;
  /** Optional structured logger for retry decisions. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RetryDecision {
  kind: 'retry' | 'exhausted' | 'skipped';
  reason?: string;
  sprintId?: SprintId;
  newTaskId?: TaskId;
}

export interface VerifierFailedPayload {
  runId: string;
  status: 'failed' | 'timeout';
  attempt: number;
  failures: ReadonlyArray<VerifierFailure>;
  rawLogUrl?: string;
}

/**
 * Decide whether a verifier.failed event triggers a retry and, if so, submit
 * the retry sprint. Pure-by-default: only side-effects via the supplied deps.
 */
export async function handleVerifierFailed(
  event: OrchestratorEvent,
  deps: RetryOrchestratorDeps,
): Promise<RetryDecision> {
  if (event.kind !== 'verifier.failed' && event.kind !== 'verifier.timeout') {
    return { kind: 'skipped', reason: `unexpected event kind ${event.kind}` };
  }
  const taskId = event.taskId;
  if (!taskId) {
    return { kind: 'skipped', reason: 'event missing taskId' };
  }
  const payload = event.payload as unknown as VerifierFailedPayload;
  const attempt = payload.attempt ?? 1;
  const failures = payload.failures ?? [];

  if (attempt >= MAX_VERIFIER_ATTEMPTS) {
    deps.log?.('verifier: max attempts reached, escalating to human', {
      taskId,
      attempt,
      failureCount: failures.length,
    });
    await deps.postFailureSurface({
      taskId,
      attempt,
      failures,
      rawLogUrl: payload.rawLogUrl,
      exhausted: true,
    });
    return { kind: 'exhausted' };
  }

  const original = await deps.loadOriginalBrief(taskId);
  if (!original) {
    deps.log?.('verifier: cannot retry, original brief not found', { taskId });
    await deps.postFailureSurface({
      taskId,
      attempt,
      failures,
      rawLogUrl: payload.rawLogUrl,
      exhausted: true,
    });
    return { kind: 'skipped', reason: 'original brief not found' };
  }

  const retryBrief = buildRetryBrief(original, attempt + 1, failures);
  const submitted = await deps.submitRetrySprint({
    originalTaskId: taskId,
    retryAttempt: attempt + 1,
    brief: retryBrief,
  });
  deps.log?.('verifier: retry sprint queued', {
    taskId,
    newTaskId: submitted.taskId,
    sprintId: submitted.sprintId,
    attempt: attempt + 1,
  });
  // Post the failure surface alongside the retry so the operator sees what's
  // happening; buttons are still actionable in case they want to skip the retry.
  await deps.postFailureSurface({
    taskId,
    attempt,
    failures,
    rawLogUrl: payload.rawLogUrl,
    exhausted: false,
  });
  return { kind: 'retry', sprintId: submitted.sprintId, newTaskId: submitted.taskId };
}

/** Compose the retry brief: feedback header + verbatim original brief. */
export function buildRetryBrief(
  original: string,
  nextAttempt: number,
  failures: ReadonlyArray<VerifierFailure>,
): string {
  const summary = failures
    .slice(0, 20)
    .map((f) => {
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : ''}` : '';
      return `- ${f.kind}${loc} — ${f.message}`;
    })
    .join('\n');
  const overflow =
    failures.length > 20 ? `\n(+ ${failures.length - 20} more — see raw log)\n` : '';
  return [
    `## Verifier feedback (retry attempt ${nextAttempt} of ${MAX_VERIFIER_ATTEMPTS})`,
    'The previous attempt opened a PR but failed verifier checks below. Fix the listed issues.',
    'Do not re-introduce regressions: only address these specific failures.',
    '',
    summary || '- (no parseable failures; consult raw log)',
    overflow,
    '',
    '---',
    '',
    original,
  ].join('\n');
}

/**
 * Convenience wiring: attach `handleVerifierFailed` to an event-emitter-style
 * orchestrator. Returns an off() function so tests / shutdown can unsubscribe.
 */
export interface RetryLoopSubscription {
  off(): void;
}

export function wireRetryLoop(
  on: (kind: string, cb: (event: OrchestratorEvent) => void) => void,
  off: (kind: string, cb: (event: OrchestratorEvent) => void) => void,
  deps: RetryOrchestratorDeps,
): RetryLoopSubscription {
  const handler = (event: OrchestratorEvent): void => {
    void handleVerifierFailed(event, deps).catch((err) => {
      deps.log?.(`verifier: retry handler threw — ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  on('event', handler);
  return {
    off: () => off('event', handler),
  };
}

/**
 * Build the ControlPlane payload that the Discord [Retry] button dispatches.
 * Used by interaction-create.ts in the Discord client when the operator clicks
 * the structured-failure thread reply.
 */
export function buildRetryControlCommand(taskId: TaskId): {
  type: 'sprint_goal';
  goal: string;
  forceVerifierRetry: true;
  parentTaskId: string;
} {
  return {
    type: 'sprint_goal',
    goal: `Re-run verifier for task ${taskId}`,
    forceVerifierRetry: true,
    parentTaskId: taskId,
  };
}

/** ControlPlaneClient marker type — re-export to keep the contracts surface tight. */
export type { ControlPlaneClient };
