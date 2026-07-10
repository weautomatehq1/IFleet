// RoutingStrategy — the contract seam that lets `src/pipeline/factory.ts`
// decide how a task's classifier + bandit-live overrides + closure-log get
// applied without importing `../agents/bandit/*`, `../classifier/*`, or
// `../orchestrator/closure-log.js` directly.
//
// Before this contract existed, `factory.ts` reached into four different
// modules to produce and mutate a `RoutingDecision`. Extracting that as a
// pure interface here lets the pipeline package depend on ONE injected
// strategy while the concrete bandit + closure-log wiring stays in the
// application-side `src/pipeline/default-routing-strategy.ts`.
//
// The default implementation preserves the exact pre-contract behavior; a
// test or alt-orchestrator can swap in a deterministic strategy without
// having to stub bandit + classifier internals.

import type { RoutingDecision } from './routing.js';

/** Minimal task shape the strategy needs to classify + shadow-log. */
export interface RoutingStrategyTask {
  id: string;
  repo: string;
  title: string;
  body: string;
  labels: ReadonlyArray<string>;
  mode?: string | undefined;
}

/**
 * Opaque DB handle passed to the bandit apply step. Kept as `unknown` at the
 * contract layer so `@wahq/orchestrator-core/contracts/*` never has to grow
 * a `better-sqlite3` dependency — the concrete strategy narrows it.
 */
export type RoutingStrategyDb = unknown;

export interface ApplyBanditOpts {
  /** Test-only override for the `BANDIT_LIVE` env flag. */
  live?: boolean;
  /** Injected decision timestamp for test determinism. */
  now?: number;
}

export interface RoutingStrategy {
  /**
   * Classify a task and return the initial routing decision. Deterministic:
   * same task in → same routing out. No I/O.
   */
  classify(task: RoutingStrategyTask): RoutingDecision;

  /**
   * Apply the bandit's would-be pick to `routing` IN PLACE when
   * `BANDIT_LIVE` is on; always shadow-log first. No-op when the db handle
   * is absent (test fixtures without sqlite wiring).
   */
  applyBanditRouting(
    db: RoutingStrategyDb | undefined,
    routing: RoutingDecision,
    task: Pick<RoutingStrategyTask, 'id' | 'repo'>,
    opts?: ApplyBanditOpts,
  ): void;

  /**
   * Emit the [ROUTING-DECISION-LOG] line for the post-bandit routing. Called
   * AFTER `applyBanditRouting` so `final_tier` reflects the model that
   * actually runs.
   */
  logDecision(taskId: string, routing: RoutingDecision): void;
}
