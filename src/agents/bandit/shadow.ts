// M6-T2 — Shadow-mode bandit logger.
//
// `recordShadowDecision` is the integration seam. The caller passes (a)
// the live routing decision that's already been made and (b) the
// observation history (one `{arm, reward}` per merged/rejected PR for
// each model). The function:
//   1. Builds Beta posteriors via `posteriorsFromObservations`.
//   2. Samples each arm and picks the argmax via `sampleArm`.
//   3. Persists the would-be pick to `routing_shadow_log`.
// It NEVER overrides the actual model — that's M6 closure (gated on a
// 25% cost-per-task win in shadow mode).
//
// Fail-open: any error here is logged and swallowed. Shadow data going
// missing is a learning regression, not a correctness regression.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

type DB = Database.Database;

import { posteriorsFromObservations, sampleArm } from './thompson.js';
import type { ArmPosterior } from './thompson.js';

export interface ShadowDecisionInput {
  /** The task id this routing decision is for. */
  taskId: string;
  /** Repo the task targets — useful for downstream slicing. */
  repo: string;
  /** Wall-clock at decision time. Injected for test determinism. */
  decidedAt: number;
  /** The model the live routing picked. */
  actualModel: string;
  /**
   * History of past outcomes per model arm. The caller typically reads
   * this from `pr_decisions`:
   *   verdict='merged' → reward=1, verdict='rejected' → reward=0.
   * `verdict='abandoned'` should be filtered out by the caller — we
   * don't carry a third reward state.
   */
  observations: ReadonlyArray<{ arm: string; reward: 0 | 1 }>;
  /**
   * Universe of model arms to evaluate. Including a never-observed arm
   * is fine — it gets the uniform prior and a wide Beta sample. The
   * live routing model is included implicitly via the observations
   * stream, but the caller should add the full known-model set here so
   * never-tried alternatives still have a chance to be sampled.
   */
  knownArms: readonly string[];
  /** Override the RNG for tests. */
  rng?: () => number;
}

export interface ShadowDecisionRecord {
  id: string;
  taskId: string;
  repo: string;
  decidedAt: number;
  actualModel: string;
  shadowModel: string;
  posteriors: ArmPosterior[];
  samples: Record<string, number>;
}

/**
 * Sample a shadow pick and persist it. Returns the record on success.
 *
 * Throws ONLY on programmer error (empty `knownArms` — calling with no
 * arms is a bug in the caller, not a runtime failure). SQLite errors
 * and sampler errors are caught and surfaced as `null` so the live
 * routing path is never broken by a shadow-logging hiccup. The caller
 * MAY treat null as "shadow data unavailable for this task" and move
 * on; do not let it bubble.
 */
export function recordShadowDecision(
  db: DB,
  input: ShadowDecisionInput,
): ShadowDecisionRecord | null {
  if (input.knownArms.length === 0) {
    throw new Error('recordShadowDecision requires ≥1 knownArm');
  }
  try {
    const posteriors = posteriorsFromObservations(input.observations, input.knownArms);
    const { samples, pick } = sampleArm(posteriors, input.rng);
    const id = `shadow_${randomUUID()}`;

    // Snapshot the per-arm α/β so the dashboard can replay decisions.
    const alphaSnap: Record<string, number> = {};
    const betaSnap: Record<string, number> = {};
    for (const p of posteriors) {
      alphaSnap[p.arm] = p.alpha;
      betaSnap[p.arm] = p.beta;
    }

    db.prepare(
      `INSERT INTO routing_shadow_log
         (id, task_id, repo, decided_at, actual_model,
          shadow_model, alpha_snapshot, beta_snapshot, sample_snapshot)
       VALUES (@id, @task_id, @repo, @decided_at, @actual_model,
               @shadow_model, @alpha_snapshot, @beta_snapshot, @sample_snapshot)`,
    ).run({
      id,
      task_id: input.taskId,
      repo: input.repo,
      decided_at: input.decidedAt,
      actual_model: input.actualModel,
      shadow_model: pick,
      alpha_snapshot: JSON.stringify(alphaSnap),
      beta_snapshot: JSON.stringify(betaSnap),
      sample_snapshot: JSON.stringify(samples),
    });

    return {
      id,
      taskId: input.taskId,
      repo: input.repo,
      decidedAt: input.decidedAt,
      actualModel: input.actualModel,
      shadowModel: pick,
      posteriors,
      samples,
    };
  } catch (err) {
    console.warn(
      `[bandit/shadow] recordShadowDecision failed for task ${input.taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Read back recent shadow decisions for analytics. Returns rows newest
 * first, capped at `limit`. Snapshots come back as parsed JSON.
 */
export function readShadowDecisions(
  db: DB,
  limit = 200,
): Array<{
  id: string;
  taskId: string;
  repo: string;
  decidedAt: number;
  actualModel: string;
  shadowModel: string;
  alphaSnapshot: Record<string, number>;
  betaSnapshot: Record<string, number>;
  sampleSnapshot: Record<string, number>;
}> {
  const rows = db
    .prepare(
      `SELECT id, task_id, repo, decided_at, actual_model,
              shadow_model, alpha_snapshot, beta_snapshot, sample_snapshot
         FROM routing_shadow_log
        ORDER BY decided_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    task_id: string;
    repo: string;
    decided_at: number;
    actual_model: string;
    shadow_model: string;
    alpha_snapshot: string;
    beta_snapshot: string;
    sample_snapshot: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    repo: r.repo,
    decidedAt: r.decided_at,
    actualModel: r.actual_model,
    shadowModel: r.shadow_model,
    alphaSnapshot: JSON.parse(r.alpha_snapshot) as Record<string, number>,
    betaSnapshot: JSON.parse(r.beta_snapshot) as Record<string, number>,
    sampleSnapshot: JSON.parse(r.sample_snapshot) as Record<string, number>,
  }));
}
