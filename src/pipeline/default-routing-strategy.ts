// Default RoutingStrategy — wraps the classifier + bandit + closure-log
// wiring that factory.ts used to call inline. Behavior is byte-identical to
// the pre-contract flow; the contract just moves the coupling out of
// factory.ts so alt-orchestrators (or tests) can swap in a deterministic
// strategy without stubbing bandit internals.
//
// The concrete bandit + closure-log imports stay in this file (not in the
// `@wahq/orchestrator-core` package) so orchestrator-core does not have to
// depend on `../agents/bandit/*` and `../orchestrator/closure-log.js`.

import type Database from 'better-sqlite3';
import type {
  RoutingStrategy,
  RoutingStrategyTask,
  ApplyBanditOpts,
} from '@wahq/orchestrator-core/contracts/routing-strategy';
import type { RoutingDecision, SprintMode } from './types.js';
import { buildShadowObservations } from '../agents/bandit/observations.js';
import { KNOWN_MODEL_IDS } from '../agents/bandit/known-arms.js';
import { resolveRoutingModel } from '../agents/bandit/live.js';
import { classifyTask, modelToTier } from '../classifier/index.js';
import { writeRoutingDecisionLog } from '../orchestrator/closure-log.js';

export interface DefaultRoutingStrategyDeps {
  /** Injected `Date.now()` for test determinism. */
  now?: () => string;
  /** Injected line sink for closure-log emission (defaults to console). */
  sink?: (line: string) => void;
}

export function createDefaultRoutingStrategy(
  deps: DefaultRoutingStrategyDeps = {},
): RoutingStrategy {
  const now = deps.now ?? (() => new Date().toISOString());
  const sink = deps.sink;

  return {
    classify(task: RoutingStrategyTask): RoutingDecision {
      return classifyTask({
        title: task.title,
        body: task.body,
        labels: [...task.labels],
        mode: (task.mode as SprintMode | null | undefined) ?? undefined,
      });
    },

    applyBanditRouting(
      db: unknown,
      routing: RoutingDecision,
      task: { id: string; repo: string },
      opts: ApplyBanditOpts = {},
    ): void {
      if (!db) return;
      const sqliteDb = db as Database.Database;
      const ROLES = ['architect', 'editor', 'reviewer'] as const;
      for (const role of ROLES) {
        try {
          const routed = resolveRoutingModel(
            sqliteDb,
            {
              taskId: task.id,
              repo: task.repo,
              decidedAt: opts.now ?? Date.now(),
              actualModel: routing[role].model,
              observations: buildShadowObservations(sqliteDb, task.repo, role),
              knownArms: KNOWN_MODEL_IDS,
              role,
            },
            opts.live === undefined ? {} : { live: opts.live },
          );
          if (routed.overridden) {
            routing[role].model = routed.model;
          }
        } catch (err) {
          console.warn(
            `[shadow] resolveRoutingModel wiring failed for ${role} on task ${task.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },

    logDecision(taskId: string, routing: RoutingDecision): void {
      if (!routing._meta) return;
      const finalTier = modelToTier(routing.architect.model) ?? routing._meta.finalTier;
      writeRoutingDecisionLog(
        {
          task_id: taskId,
          hit_keyword: routing._meta.hitKeyword,
          final_tier: finalTier,
          raw_score: routing._meta.rawScore,
          decided_at: now(),
        },
        sink,
      );
    },
  };
}
