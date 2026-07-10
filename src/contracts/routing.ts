// Routing type root — the single source of truth for the routing/worker type
// graph. Imports NOTHING outside `contracts/`; every downstream module
// (queue, orchestrator, pipeline) imports these from here instead of
// re-declaring them "in lockstep".
//
// Before this file existed, `SprintMode`, `RoutingDecision`, `WorkerSpec`,
// `VerifyKind`, `Provider`, `Autonomy` and `RoutingHints` were duplicated
// across `pipeline/types.ts`, `orchestrator/types.ts` and `queue/types.ts`,
// and `contracts/task.ts` imported them *downstream* — inverting the
// dependency direction the contract root is supposed to have. Hoisting them
// here breaks that cycle: `task.ts` now depends only on `./routing.js`.

/** Verify steps a pipeline run may execute. */
export type VerifyKind = 'typecheck' | 'lint' | 'test' | 'playwright' | 'screenshot';

/** Worker provider backing a role spawn. */
export type Provider = 'claude' | 'codex';

/** Whether a task auto-ships or waits for human review. */
export type Autonomy = 'auto' | 'review';

/**
 * Per-task routing mode emitted by the classifier (or its auto-router). Picks
 * the architect/editor prompt template and any mode-specific model overrides in
 * `config/routing.json`. `standard` is the fall-through default and is also the
 * value returned when the auto-router is below its confidence threshold.
 *
 * The four named modes mirror operator slash-commands the team already uses:
 *   - `ralph`   — persistence loop: keep retrying until verify is green
 *   - `ulw`     — ultrawork: parallel multi-file work
 *   - `tdd`     — tests first, implementation second
 *   - `deslop`  — clean generic AI-slop code (rewrite to project conventions)
 */
export type SprintMode = 'standard' | 'ralph' | 'ulw' | 'tdd' | 'deslop';

/** A single role assignment (provider + model + worker id). */
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

export interface RoutingHints {
  model?: 'opus' | 'sonnet' | 'haiku' | 'codex';
  priority: 'low' | 'normal' | 'high';
  verify: VerifyKind[];
  autonomy: 'auto' | 'review';
  /**
   * Explicit category label (canonical §3.2 override #1). When set to one of
   * {security, auth, payments, migration}, the classifier promotes the
   * architect to Opus regardless of severity or mode (M4.7).
   */
  category?: 'security' | 'auth' | 'payments' | 'migration';
  /**
   * Explicit severity label (canonical §3.2 override #2). When set to
   * 'critical', the classifier promotes the architect to Opus regardless of
   * category or mode (M4.7).
   */
  severity?: 'critical' | 'important' | 'cosmetic';
}
