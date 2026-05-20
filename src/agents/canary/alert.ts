/**
 * Verifier↔reviewer disagreement-rate canary alerter.
 *
 * Reads a snapshot from {@link VerifierStoreBridge}, compares the rate to a
 * threshold (default 0.25), and posts to a Discord channel ONLY when the
 * state transitions:
 *   - below or unknown → above   ⇒ "🚨 canary tripped"
 *   - above            → below   ⇒ "✅ canary recovered"
 *
 * Steady-state ticks (above→above, below→below) are no-ops. The dedup
 * state lives in {@link CanaryStateStore}.
 *
 * This module is pure orchestration — the caller wires in the bridge, the
 * state store, and a `postAlert` function. The PM2 cron entry at
 * `scripts/canary-alert.ts` does the wiring.
 */

import type { DisagreementSnapshot, VerifierStoreBridge } from '../verifier/store-bridge.js';
import { CanaryStateStore, type CanaryState, type CanaryStateKind } from './state-store.js';

export const DEFAULT_DISAGREEMENT_THRESHOLD = 0.25;
export const DEFAULT_WINDOW_DAYS = 7;

export type CanaryTransitionKind = 'tripped' | 'recovered' | 'none';

export interface CanaryEvaluation {
  transition: CanaryTransitionKind;
  /** Why we did or did not transition, for logs. */
  reason:
    | 'insufficient-samples'
    | 'crossed-up'
    | 'crossed-down'
    | 'still-above'
    | 'still-below'
    | 'baseline-above'
    | 'baseline-below';
  snapshot: DisagreementSnapshot;
  /** State BEFORE this evaluation. */
  prior: CanaryState;
  /** State AFTER this evaluation (only differs from `prior` when transition !== 'none'). */
  next: CanaryState;
}

export interface AlertMessageInput {
  snapshot: DisagreementSnapshot;
  threshold: number;
  transition: 'tripped' | 'recovered';
  /** Optional helper that returns a URL/text for inspecting the offending runs. */
  inspectionHint?: string;
}

export interface RunCanaryAlertDeps {
  bridge: Pick<VerifierStoreBridge, 'getDisagreementSnapshot'>;
  store: CanaryStateStore;
  postAlert: (text: string) => Promise<void>;
  threshold?: number;
  windowDays?: number;
  inspectionHint?: string;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

export function formatAlertMessage(input: AlertMessageInput): string {
  const { snapshot, threshold, transition } = input;
  const pct = snapshot.rate === null ? 'n/a' : `${(snapshot.rate * 100).toFixed(1)}%`;
  const window =
    snapshot.windowDays === null ? 'all-time' : `last ${snapshot.windowDays}d`;
  const head =
    transition === 'tripped'
      ? `🚨 **Canary tripped — verifier disagreement above threshold**`
      : `✅ **Canary recovered — verifier disagreement back below threshold**`;
  const lines = [
    head,
    `• Rate: \`${pct}\` (threshold \`${(threshold * 100).toFixed(1)}%\`)`,
    `• Window: ${window} — \`${snapshot.failed}/${snapshot.total}\` failed runs`,
  ];
  if (input.inspectionHint) {
    lines.push(`• Inspect: ${input.inspectionHint}`);
  }
  return lines.join('\n');
}

function classify(snapshot: DisagreementSnapshot, threshold: number): CanaryStateKind {
  if (snapshot.rate === null) return 'unknown';
  return snapshot.rate >= threshold ? 'above' : 'below';
}

/**
 * Pure evaluation step — given a prior state and a fresh snapshot, decide
 * whether to alert and what the next state should be. Exposed for testing.
 */
export function evaluateTransition(
  prior: CanaryState,
  snapshot: DisagreementSnapshot,
  threshold: number,
  nowMs: number,
): CanaryEvaluation {
  const observed = classify(snapshot, threshold);

  if (observed === 'unknown') {
    return {
      transition: 'none',
      reason: 'insufficient-samples',
      snapshot,
      prior,
      next: prior,
    };
  }

  // First-ever evaluation that has enough samples: record the baseline
  // silently. Only future *transitions* fire alerts.
  if (prior.kind === 'unknown') {
    return {
      transition: 'none',
      reason: observed === 'above' ? 'baseline-above' : 'baseline-below',
      snapshot,
      prior,
      next: {
        kind: observed,
        lastTransitionRate: snapshot.rate,
        lastTransitionAtMs: nowMs,
      },
    };
  }

  if (prior.kind === observed) {
    return {
      transition: 'none',
      reason: observed === 'above' ? 'still-above' : 'still-below',
      snapshot,
      prior,
      next: prior,
    };
  }

  // Transition.
  const transition: CanaryTransitionKind = observed === 'above' ? 'tripped' : 'recovered';
  return {
    transition,
    reason: observed === 'above' ? 'crossed-up' : 'crossed-down',
    snapshot,
    prior,
    next: {
      kind: observed,
      lastTransitionRate: snapshot.rate,
      lastTransitionAtMs: nowMs,
    },
  };
}

/**
 * End-to-end canary tick. Reads → evaluates → posts (only on transition) →
 * persists. Returns the evaluation so the caller can log it.
 */
export async function runCanaryAlert(deps: RunCanaryAlertDeps): Promise<CanaryEvaluation> {
  const threshold = deps.threshold ?? DEFAULT_DISAGREEMENT_THRESHOLD;
  const windowDays = deps.windowDays ?? DEFAULT_WINDOW_DAYS;
  const nowMs = (deps.now ?? Date.now)();

  const snapshot = deps.bridge.getDisagreementSnapshot(windowDays);
  const prior = deps.store.read();
  const evaluation = evaluateTransition(prior, snapshot, threshold, nowMs);

  if (evaluation.transition === 'tripped' || evaluation.transition === 'recovered') {
    const message = formatAlertMessage({
      snapshot,
      threshold,
      transition: evaluation.transition,
      ...(deps.inspectionHint !== undefined ? { inspectionHint: deps.inspectionHint } : {}),
    });
    await deps.postAlert(message);
  }

  // Persist after the post — if the post throws we'll re-alert next tick.
  if (evaluation.next !== prior) {
    deps.store.write(evaluation.next);
  }

  return evaluation;
}
