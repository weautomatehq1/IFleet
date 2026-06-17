// M6 closure substrate — bandit shadow→live flip.
//
// `recordShadowDecision` (shadow.ts) samples a Thompson arm and logs it, but
// never changes the model the live routing already picked. This module is the
// `BANDIT_LIVE` seam: it wraps `recordShadowDecision` so the shadow row is
// STILL written every time (the #370 behavior is preserved), and then — only
// when the flag is ON — promotes the sampled arm to the actual routing
// decision.
//
// OFF (default): `model` === the live `actualModel`. Pure shadow mode, byte
// for byte the current behavior. Flip only after the shadow-mode
// cost-per-task win clears -25%.
//
// Fail-safe: when the shadow write fails (`record === null`) we NEVER
// override — falling back to the live decision is always correct, and a
// shadow-logging hiccup must not change which model runs.

import type Database from 'better-sqlite3';

import { recordShadowDecision } from './shadow.js';
import type { ShadowDecisionInput, ShadowDecisionRecord } from './shadow.js';

export const BANDIT_LIVE_ENV = 'BANDIT_LIVE';

/**
 * Read the `BANDIT_LIVE` flag from the env. Matches the codebase's flag
 * convention (`'1'` or `'true'` ⇒ on; anything else ⇒ off), the same shape
 * `drift-scan-run.ts` / `proposer-run.ts` use.
 */
export function banditLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BANDIT_LIVE_ENV] === '1' || env[BANDIT_LIVE_ENV] === 'true';
}

export interface ResolvedRouting {
  /** The model the caller should actually route to. */
  model: string;
  /** The live routing decision before the bandit. */
  actualModel: string;
  /** The Thompson-sampled arm (null when the shadow write failed). */
  shadowModel: string | null;
  /** True iff the bandit changed the decision (`model !== actualModel`). */
  overridden: boolean;
  /** The persisted shadow record (null on a fail-open shadow write). */
  record: ShadowDecisionRecord | null;
}

/**
 * Record the shadow decision and resolve the model to actually use.
 *
 * Always calls `recordShadowDecision` first, so shadow logging continues
 * regardless of the flag. Then:
 *   - `BANDIT_LIVE` OFF  ⇒ `model = actualModel` (shadow-only, unchanged).
 *   - `BANDIT_LIVE` ON   ⇒ `model = record.shadowModel` (sampled arm wins).
 *
 * `opts.live` overrides the env read — tests pass it for determinism; the
 * orchestrator can omit it to take the env flag.
 */
export function resolveRoutingModel(
  db: Database.Database,
  input: ShadowDecisionInput,
  opts: { live?: boolean } = {},
): ResolvedRouting {
  const record = recordShadowDecision(db, input);
  const live = opts.live ?? banditLiveEnabled();

  if (live && record) {
    return {
      model: record.shadowModel,
      actualModel: input.actualModel,
      shadowModel: record.shadowModel,
      overridden: record.shadowModel !== input.actualModel,
      record,
    };
  }

  return {
    model: input.actualModel,
    actualModel: input.actualModel,
    shadowModel: record?.shadowModel ?? null,
    overridden: false,
    record,
  };
}
