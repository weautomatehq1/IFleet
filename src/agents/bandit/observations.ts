// M6-T3 — Thompson observation reader.
//
// Joins `pr_decisions.verdict` against `tasks.routing_decision` to produce
// the `(arm, reward)` history the bandit's Beta posterior needs. Only
// merged/rejected verdicts emit observations — `abandoned` is filtered out
// (shadow.ts contract: no third reward state).
//
// Failure modes that must NOT throw:
//   - Rows with NULL routing_decision (pre-M6 historical data).
//   - Rows where `json_extract(routing_decision, '$.<role>.model')` returns
//     NULL (malformed blob — the recorder dropped the field). Surfaced by
//     the typeof check below.

import type Database from 'better-sqlite3';

type BanditRole = 'architect' | 'editor' | 'reviewer';

export interface ShadowObservation {
  arm: string;
  reward: 0 | 1;
}

/**
 * Read `(arm, reward)` observations for one role from a sqlite handle.
 *
 * `json_extract`'s second arg cannot be parameterised (better-sqlite3
 * binds it as a literal, not a path) — we whitelist the role enum and
 * build the path string inline. Without this guard, a caller passing
 * untrusted input could inject into the JSON path; the enum check makes
 * that impossible at the type system AND runtime levels.
 */
export function buildShadowObservations(
  db: Database.Database,
  repo: string,
  role: BanditRole,
): ShadowObservation[] {
  if (role !== 'architect' && role !== 'editor' && role !== 'reviewer') {
    throw new Error(`buildShadowObservations: unknown role "${String(role)}"`);
  }
  const path = `$.${role}.model`;

  const rows = db
    .prepare(
      `SELECT p.verdict AS verdict,
              json_extract(t.routing_decision, '${path}') AS arm
         FROM pr_decisions p
         JOIN tasks t ON p.task_id = t.id
        WHERE p.repo = ?
          AND t.routing_decision IS NOT NULL
          AND p.verdict IN ('merged','rejected')`,
    )
    .all(repo) as Array<{ verdict: string; arm: unknown }>;

  const obs: ShadowObservation[] = [];
  for (const r of rows) {
    if (typeof r.arm !== 'string' || r.arm.length === 0) continue;
    if (r.verdict === 'merged') obs.push({ arm: r.arm, reward: 1 });
    else if (r.verdict === 'rejected') obs.push({ arm: r.arm, reward: 0 });
  }
  return obs;
}
