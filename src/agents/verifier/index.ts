/**
 * VerifierAgent — orchestrates a single verifier run and emits the trace events
 * downstream consumers (SprintManager, Discord notifier, PR opener) subscribe to.
 *
 * M0.W1 scaffold goals:
 *   1. Lock the event contract (verifier.started / passed / failed / timeout / error)
 *      before any sunk cost in implementations.
 *   2. Provide a stub-backed VerifierAgent that emits verifier.passed
 *      unconditionally so callers can be wired without Docker on the loop.
 *   3. Document the call-site for M1.W1 wiring into SprintManager.
 *
 * Wiring (M1.W1, NOT in this commit):
 *   In src/orchestrator/sprint.ts, after `task.completed` resolves with a SHA,
 *   call `verifierAgent.verify({ taskId, sprintId, repoUrl, branch, sha, attempt })`.
 *   On `verifier.failed` with attempt < MAX_RETRIES, re-queue to the editor with
 *   the failures as feedback. On `verifier.passed`, hand off to the PR-opener.
 */

import type { OrchestratorEvent, SprintId, TaskId } from '../../orchestrator/types.js';
import { StubSandboxRunner, type SandboxRunner } from './sandbox.js';
import type {
  VerifierEventKind,
  VerifierRunInput,
  VerifierRunResult,
} from './types.js';

export interface VerifierAgentOptions {
  /** Emits events into the same OrchestratorEvent stream the SprintManager uses. */
  emit: (event: OrchestratorEvent) => void;
  /** Sandbox runner — defaults to the stub. Real Docker runner arrives M1.W2. */
  sandbox?: SandboxRunner;
  /** Override the clock for tests. */
  now?: () => number;
}

export interface VerifyOpts extends Omit<VerifierRunInput, 'attempt'> {
  /** Which retry attempt (1..MAX_RETRIES). Caller enforces the cap. */
  attempt?: number;
}

/**
 * Maximum retry attempts before the verifier gives up and surfaces failure to
 * the human. Mirrored from docs/elevation/upgrades/01-verifier.md (max-3-retry rule).
 */
export const MAX_VERIFIER_ATTEMPTS = 3;

export class VerifierAgent {
  private readonly emit: (event: OrchestratorEvent) => void;
  private readonly sandbox: SandboxRunner;
  private readonly now: () => number;

  constructor(opts: VerifierAgentOptions) {
    this.emit = opts.emit;
    this.sandbox = opts.sandbox ?? new StubSandboxRunner({ now: opts.now });
    this.now = opts.now ?? Date.now;
  }

  /**
   * Verify a single editor output. Emits verifier.started, then exactly one of
   * verifier.{passed,failed,timeout,error}. Returns the final result for
   * callers that prefer to await rather than subscribe.
   */
  async verify(opts: VerifyOpts): Promise<VerifierRunResult> {
    const attempt = opts.attempt ?? 1;
    const input: VerifierRunInput = {
      taskId: opts.taskId,
      sprintId: opts.sprintId,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      sha: opts.sha,
      attempt,
    };

    // Emit verifier.started before the sandbox runs so subscribers (e.g. Discord
    // progress posts) observe the correct event ordering. runId is not yet known
    // here; emit a stable placeholder derived from the attempt so the event is
    // still queryable. The authoritative runId is on the final result event.
    this.emitEvent('verifier.started', opts.sprintId, opts.taskId, {
      runId: `verifier-pending-attempt-${attempt}`,
      attempt,
    });

    let result: VerifierRunResult;
    try {
      result = await this.sandbox.run(input);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent('verifier.error', opts.sprintId, opts.taskId, {
        error: errorMsg,
        attempt,
      });
      throw err;
    }

    const finalKind: VerifierEventKind =
      result.status === 'passed'
        ? 'verifier.passed'
        : result.status === 'timeout'
        ? 'verifier.timeout'
        : 'verifier.failed';

    this.emitEvent(finalKind, opts.sprintId, opts.taskId, result as unknown as Record<string, unknown>);
    return result;
  }

  private emitEvent(
    kind: VerifierEventKind,
    sprintId: SprintId,
    taskId: TaskId,
    payload: Record<string, unknown>,
  ): void {
    this.emit({
      ts: this.now(),
      sprintId,
      taskId,
      kind,
      payload,
    });
  }
}

export type { VerifierRunInput, VerifierRunResult } from './types.js';
export { StubSandboxRunner, DockerSandboxRunner } from './sandbox.js';
