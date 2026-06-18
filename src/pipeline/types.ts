import type { InterviewPoster } from './interview.js';

// Public types for the Architect → Editor → Reviewer pipeline.
//
// Other modules (queue, workers, verify) own the placeholder interfaces below;
// they are declared here as the minimum shape this package depends on so the
// pipeline can compile and be unit-tested in isolation.

export type VerifyKind =
  | 'typecheck'
  | 'lint'
  | 'test'
  | 'playwright'
  | 'screenshot';

export type Provider = 'claude' | 'codex';

export type Autonomy = 'auto' | 'review';

/**
 * Per-task routing mode mirrored from `src/orchestrator/types.ts.SprintMode`.
 * Re-declared here to keep the pipeline package free of an inbound cross-package
 * import (same pattern as {@link QueuedTask} below). Kept in lockstep with the
 * orchestrator union; adding a new mode requires updates in both files.
 */
export type SprintMode = 'standard' | 'ralph' | 'ulw' | 'tdd' | 'deslop';

export interface QueuedTask {
  id: string;
  issueNumber: number;
  repo: string;
  title: string;
  body: string;
  autonomy: Autonomy;
  labels: string[];
  /**
   * Per-task routing mode. Read by the architect/editor steps to pick the
   * mode-specific prompt template; absent / `null` → use the standard prompt.
   * Mirrored from {@link QueuedTask} in `src/contracts/task.ts`.
   */
  mode?: SprintMode | null;
}

export interface WorkerSpec {
  provider: Provider;
  model: string;
  workerId: string;
}

export interface RoutingDecision {
  architect: WorkerSpec;
  editor: WorkerSpec;
  reviewer: WorkerSpec;
  // Optional plan-reviewer. Runs between architect and editor and can veto
  // the plan with structured reasons (M2 — see
  // docs/elevation/upgrades/02-plan-reviewer.md). Absent → plan-review is
  // disabled and the pipeline behaves exactly as in M1 (architect → editor
  // → diff-reviewer).
  planReviewer?: WorkerSpec;
  // Optional cheap first-pass reviewer. When present, the pipeline runs this
  // worker before the full reviewer; a CLEAN verdict short-circuits the round
  // and the full reviewer is never spawned. Absent → gate disabled.
  haikuGate?: WorkerSpec;
  verify: VerifyKind[];
  /**
   * Per-task routing mode chosen by the classifier. Architect/editor use this
   * to pick the mode-specific prompt template; absent / `null` → use the
   * standard prompt. Set by `classifyTask` when an explicit `mode:*` label is
   * present or when the auto-router emits a high-confidence mode.
   */
  mode?: SprintMode | null;
  /** Routing telemetry for false-positive rate analysis. Populated by classifyTask; absent on pre-M4.X rows. */
  _meta?: { hitKeyword: string | null; rawScore: number; finalTier: 'haiku' | 'sonnet' | 'opus' };
}

export interface SpawnOpts {
  worktreePath?: string;
  systemPrompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  abortSignal?: AbortSignal;
  role: 'architect' | 'editor' | 'reviewer' | 'doctor';
}

export interface SpawnResult {
  ok: boolean;
  output: string;
  sessionId: string;
  rateLimitHits: number;
  // Worker-reported USD cost when the underlying CLI surfaces it (Claude emits
  // `total_cost_usd` in its `result` event). Undefined when the worker does not
  // report cost (e.g. Codex today). Pipeline consumers must treat undefined as
  // "unknown", not "free".
  totalCostUsd?: number;
  // Token count (input + output, excluding cache) from the result event.
  totalTokens?: number;
  error?: string;
}

export interface SpawnHandle {
  result(): Promise<SpawnResult>;
  cancel(): Promise<void>;
}

export interface WorkerPool {
  spawn(spec: WorkerSpec, brief: string, opts: SpawnOpts): SpawnHandle;
}

export interface VerifyResult {
  ok: boolean;
  failures: Array<{ kind: VerifyKind; log: string }>;
}

export interface VerifyRunner {
  run(worktreePath: string, kinds: VerifyKind[]): Promise<VerifyResult>;
}

export interface IssueCommenter {
  comment(issueNumber: number, body: string): Promise<void>;
  waitForApproval(issueNumber: number, opts: WaitForApprovalOpts): Promise<boolean>;
}

export interface WaitForApprovalOpts {
  approver: string;
  pollIntervalMs: number;
  timeoutMs: number;
  abortSignal: AbortSignal;
}

export interface PrOpener {
  open(input: OpenPrInput): Promise<{ url: string; number: number }>;
}

export interface OpenPrInput {
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  issueNumber: number;
  reviewers: string[];
}

export interface GitOps {
  diff(worktreePath: string, baseRef: string): Promise<string>;
  currentBranch(worktreePath: string): Promise<string>;
}

export interface PipelineInput {
  task: QueuedTask;
  workerPool: WorkerPool;
  worktreePath: string;
  routing: RoutingDecision;
  abortSignal: AbortSignal;
  verify: VerifyRunner;
  issues: IssueCommenter;
  pr: PrOpener;
  git: GitOps;
  codeowners: string[];
  baseBranch?: string;
  approver?: string;
  doctorMaxAttempts?: number;
  reviewerMaxRounds?: number;
  repoRoot?: string;
  sprintId?: string;
  /**
   * Optional hook called when the architect finishes and a plan is ready for
   * human review. The daemon uses this to surface the plan in a Discord
   * thread (and emit an `architect.plan_ready` orchestrator event). Returning
   * a value is ignored; failures should be swallowed by the implementation.
   */
  onArchitectPlan?: (plan: string) => void | Promise<void>;
  /**
   * Optional Discord-aware approval gate. When set, the architect uses this
   * instead of `IssueCommenter.waitForApproval` (the GitHub-only path). The
   * daemon resolves the returned promise when a `approve` / `reject` /
   * `cancel` ControlCommand POSTs in for this taskId. Resolve to `true` on
   * approve, `false` on reject/cancel/timeout.
   */
  approvalGate?: ApprovalGate;
  /**
   * Optional poster for the deep-interview phase. When set AND the brief is
   * vague, the architect asks up to 3 clarifying questions, posts them via
   * this poster, and the pipeline halts with status `awaiting_interview`.
   * Absent → interview phase disabled.
   * `repoRoot` (above) doubles as the source for `.omc/learnings.md`.
   */
  interviewPoster?: InterviewPoster;
  /**
   * Optional structured-event sink. When set, the runner emits
   * {@link PipelineEvent} values at observability checkpoints (e.g. the haiku
   * cost-split gate short-circuiting the full reviewer). Absent → events are
   * silently dropped. The sink must be synchronous and non-throwing; failures
   * inside the sink must not affect the pipeline result.
   */
  eventSink?: PipelineEventSink;
}

/**
 * Structured observability events emitted by the pipeline runner during a run.
 * Consumers wire a sink into {@link PipelineInput.eventSink} to forward these
 * into the orchestrator event log, Discord, etc.
 *
 * Today only `reviewer.haiku_gate_passed` is defined (issue #109); other
 * reviewer/architect events should be added here as they migrate off the
 * `attempts` array and ad-hoc `console.warn` calls.
 */
export type PipelineEvent =
  | {
      kind: 'reviewer.haiku_gate_passed';
      taskId: string;
      round: number;
      gateWorkerId: string;
    }
  | {
      kind: 'plan_reviewer.vetoed';
      taskId: string;
      attempt: number;
      reasons: ReadonlyArray<{
        kind: 'invariant' | 'failure-mode' | 'scope' | 'feasibility';
        message: string;
        suggested_revision: string;
      }>;
    }
  | {
      kind: 'plan_reviewer.escalated';
      taskId: string;
      attempts: number;
      reasons: ReadonlyArray<{
        kind: 'invariant' | 'failure-mode' | 'scope' | 'feasibility';
        message: string;
        suggested_revision: string;
      }>;
    }
  | {
      kind: 'plan_reviewer.skipped';
      taskId: string;
      attempt: number;
      reason: 'rate-limit' | 'cost-cap' | 'worker-error';
    }
  | {
      // Emitted just before the runner returns status='blocked_by_reviewer'.
      // Carries the reviewer's final verdict text + concerns array so
      // operators can diagnose why the diff was rejected (issue #163).
      kind: 'reviewer.rejected';
      taskId: string;
      verdict: 'approve' | 'request_changes';
      concerns: ReadonlyArray<string>;
      raw: string;
      roundCount: number;
    };

export type PipelineEventSink = (event: PipelineEvent) => void;

export interface ApprovalGate {
  awaitApproval(opts: {
    taskId: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  }): Promise<boolean>;
}

export interface AttemptRecord {
  role: 'architect' | 'editor' | 'reviewer' | 'doctor';
  workerId: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  output: string;
  rateLimitHits: number;
  // USD cost reported by the worker, when available. Propagated from
  // `SpawnResult.totalCostUsd` so `logCosts` can record the real per-attempt
  // spend in `.omc/costs.json` and the BUDGET_USD guard can enforce end-to-end.
  totalCostUsd?: number;
  // Token count (input + output, excluding cache) reported by the worker.
  totalTokens?: number;
  // Only set on reviewer attempts when the haiku cost-split gate is active.
  // 'haiku' = approved by gate, full reviewer skipped. 'full' = gate said
  // REVIEW_NEEDED or errored, and the full reviewer ran.
  gate?: 'haiku' | 'full';
}

export type PipelineStatus =
  | 'pr_opened'
  | 'already_resolved'
  | 'blocked_by_reviewer'
  | 'awaiting_interview'
  | 'failed'
  | 'cancelled';

export interface PipelineResult {
  status: PipelineStatus;
  prUrl?: string;
  planSummary?: string;
  reviewSummary?: string;
  attempts: AttemptRecord[];
  failureReason?: string;
  // Set when status === 'awaiting_interview'. Populated by the architect's
  // deep-interview phase and used by the control plane to seed the Discord
  // thread reply handler.
  interviewQuestions?: string[];
  // Sum of input+output tokens across all attempts in this pipeline run.
  totalTokens?: number;
}

export interface PipelineRunner {
  run(input: PipelineInput): Promise<PipelineResult>;
}

export interface ReviewerVerdict {
  verdict: 'approve' | 'request_changes';
  concerns: string[];
  raw: string;
}

export interface DoctorDiagnosis {
  rootCause: string;
  proposedFix: string;
  confidence: number;
  requiresNewBrief: boolean;
  raw: string;
}
