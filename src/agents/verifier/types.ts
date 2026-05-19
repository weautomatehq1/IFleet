/**
 * VerifierAgent — closed-loop verification of editor output inside an isolated
 * Docker sandbox. See docs/elevation/upgrades/01-verifier.md and ADR-0002.
 *
 * M0.W1 scaffold: shapes only. The agent currently emits `verifier.passed`
 * unconditionally. Real sandbox invocation, failure parsing, and retry-loop
 * arrive in M1.W2.
 */

import type { SprintId, TaskId } from '../../orchestrator/types.js';

/** Stable identifier for one verifier run (NOT the same as the task it verifies). */
export type VerifierRunId = string & { readonly _brand: 'VerifierRunId' };

export const newVerifierRunId = (raw: string): VerifierRunId => raw as VerifierRunId;

/** Failure category emitted in {@link VerifierFailure.kind}. */
export type VerifierFailureKind =
  | 'build'
  | 'typecheck'
  | 'lint'
  | 'test'
  | 'invariant'
  | 'install';

export interface VerifierFailure {
  /** Failure category — drives which retry advice gets sent back to the editor. */
  kind: VerifierFailureKind;
  /** Path inside the repo (relative). Omitted for failures that aren't file-bound (e.g. install). */
  file?: string;
  line?: number;
  column?: number;
  /** Single-line human summary. */
  message: string;
  /** Raw tool output (truncated to 4kB). Persisted to S3 in full when configured. */
  rawOutput?: string;
}

/** Inputs to a single verifier run — the contract M1.W2 implementations must accept. */
export interface VerifierRunInput {
  taskId: TaskId;
  sprintId: SprintId;
  repoUrl: string;
  branch: string;
  /** Commit SHA the editor produced — what gets verified. */
  sha: string;
  /** 1-based attempt counter. Caller enforces the max-3-retry rule. */
  attempt: number;
  /**
   * Optional path to an already-checked-out worktree on the host. When set, the
   * Docker sandbox mounts this directory at /work instead of cloning. The
   * pipeline always passes this in production; `/verify <taskId>` reruns that
   * happen after the worktree was torn down fall back to clone-from-SHA when
   * the runner supports it.
   */
  worktreePath?: string;
}

export type VerifierStatus =
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'error'
  | 'partial';

/**
 * Per-phase summary appended to {@link VerifierRunResult.phases}. Surfaces in
 * Discord (`/status <taskId>`) and is persisted as part of the raw_log_url
 * artifact. Treated as best-effort — a phase that crashed before producing
 * output still appears here with `exitCode: null` and an empty output.
 */
export interface VerifierPhaseReport {
  kind: VerifierFailureKind;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** True when the phase was skipped (e.g. no `test` script in package.json). */
  skipped?: boolean;
}

export interface VerifierRunResult {
  runId: VerifierRunId;
  status: VerifierStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  attempt: number;
  /** Empty when status === 'passed'. */
  failures: ReadonlyArray<VerifierFailure>;
  /** Optional cost USD for the sandbox run. */
  costUsd?: number;
  /**
   * S3-or-equivalent URL to the full raw log. Filled by sandbox.ts once the
   * upload path lands. Undefined in the scaffold.
   */
  rawLogUrl?: string;
  /** Per-phase summary for Discord rendering. Empty in the stub. */
  phases?: ReadonlyArray<VerifierPhaseReport>;
  /**
   * Free-form banner surfaced to the operator when the sandbox could not run
   * normally (Docker daemon down → ran in-worktree; no `test` script → ran
   * build+lint+typecheck only). Drives the `verified: partial` PR label and
   * the `sandbox: unavailable` Discord banner.
   */
  banner?: string;
}

/**
 * Event payloads. These flow through {@link OrchestratorEvent.payload} as the
 * existing trace mechanism — no new event bus, just new `kind` values.
 *
 * Event `kind` constants:
 *   - `verifier.started`   — sandbox spawned, payload = {runId, attempt}
 *   - `verifier.passed`    — payload = VerifierRunResult
 *   - `verifier.failed`    — payload = VerifierRunResult (failures non-empty)
 *   - `verifier.timeout`   — payload = VerifierRunResult (status 'timeout')
 *   - `verifier.error`     — payload = {runId, error: string}
 */
export interface VerifierStartedPayload {
  runId: VerifierRunId;
  attempt: number;
}

export interface VerifierErrorPayload {
  runId: VerifierRunId;
  error: string;
}

export type VerifierEventKind =
  | 'verifier.started'
  | 'verifier.passed'
  | 'verifier.failed'
  | 'verifier.timeout'
  | 'verifier.error';
