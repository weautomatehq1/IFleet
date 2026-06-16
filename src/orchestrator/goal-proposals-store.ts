// M5 — goal_proposals persistence layer.
//
// The proposer pipeline writes one row per posted candidate via
// `insertProposal`. Discord button handlers (Approve/Reject/Defer) call
// `recordProposalDecision` via the approval-gate extension. The context
// loader (T3) calls `getPastProposalsByRepo` on the next nightly run so the
// proposer "sees what we tried."
//
// Backed by `goal_proposals` (deploy/postgres/0004-goal-proposals.sql,
// applied via `pnpm graph:migrate`). Uses the same `getKgPool()` as the
// M3 knowledge graph + M4 audits — one pool per process.
//
// Fail-open: read paths never throw — they log and return `[]` so a cold
// start (table not yet migrated) cannot crash the nightly Proposer run.
// Write paths bubble errors up because losing an insert silently would
// mean the Discord-posted candidate has no row to update later.

import type { Pool } from 'pg';

import { getKgPool, KgPostgresUnavailableError } from '../agents/indexer/pg-client.ts';
import type {
  GoalProposalRecord,
  PastProposalSummary,
  ProposalDecision,
  ProposalSource,
} from '../agents/proposer/types.ts';

/**
 * Encode a JS `number[]` embedding as the literal pgvector format
 * (`[1.0,2.0,...]`) and cast it on insert with `::vector`. Matches the M3
 * `code_nodes` writer (see ADR-0003) so we stay consistent with the one
 * convention already in production.
 */
function encodeEmbedding(emb: number[] | null | undefined): string | null {
  if (!emb || emb.length === 0) return null;
  return '[' + emb.join(',') + ']';
}

export interface InsertProposalInput {
  id: string;
  repo_id: string;
  source: ProposalSource;
  title: string;
  rationale: string;
  estimated_value: number;
  estimated_difficulty: number;
  embedding?: number[] | null;
}

/**
 * Write one proposal row. The Discord poster calls this BEFORE posting so
 * the customId on each button can reference the new row's id.
 */
export async function insertProposal(
  input: InsertProposalInput,
  pool: Pool = getKgPool(),
): Promise<void> {
  await pool.query(
    `INSERT INTO goal_proposals
       (id, repo_id, source, title, rationale,
        estimated_value, estimated_difficulty, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      input.repo_id,
      input.source,
      input.title,
      input.rationale,
      input.estimated_value,
      input.estimated_difficulty,
      encodeEmbedding(input.embedding),
    ],
  );
}

export interface RecordDecisionInput {
  proposalId: string;
  decision: ProposalDecision;
  decidedBy: string;
  /** Defaults to `new Date()`. Override only in tests for determinism. */
  decidedAt?: Date;
}

export interface RecordDecisionResult {
  /** True when a row matched proposalId; false when no row was updated. */
  updated: boolean;
}

/**
 * Idempotently apply a decision to one proposal. Returns `{ updated: false }`
 * when the proposalId doesn't exist (defensive — a Discord button click on
 * a row that was deleted between post-time and click-time).
 *
 * Approve also clears `resulting_task_id` to NULL — M5.2 will wire the
 * actual `/ship` enqueue and overwrite it then.
 */
export async function recordProposalDecision(
  input: RecordDecisionInput,
  pool: Pool = getKgPool(),
): Promise<RecordDecisionResult> {
  const decidedAt = (input.decidedAt ?? new Date()).toISOString();
  const result = await pool.query<{ id: string }>(
    `UPDATE goal_proposals
        SET decision = $2,
            decided_by = $3,
            decided_at = $4,
            resulting_task_id = CASE WHEN $2 = 'approved' THEN NULL ELSE resulting_task_id END
      WHERE id = $1
      RETURNING id`,
    [input.proposalId, input.decision, input.decidedBy, decidedAt],
  );
  return { updated: result.rowCount === 1 };
}

export interface ProposalForShip {
  id: string;
  repo_id: string;
  title: string;
  rationale: string;
}

/**
 * Read the fields the Approve→/ship wiring needs from one proposal. Returns
 * `null` when the id has no matching row — Discord's button handler treats
 * that the same as "proposal already pruned" without throwing.
 */
export async function getProposalForShip(
  proposalId: string,
  pool: Pool = getKgPool(),
): Promise<ProposalForShip | null> {
  const result = await pool.query<{
    id: string;
    repo_id: string;
    title: string;
    rationale: string;
  }>(
    `SELECT id, repo_id, title, rationale
       FROM goal_proposals
      WHERE id = $1
      LIMIT 1`,
    [proposalId],
  );
  return result.rows[0] ?? null;
}

/**
 * Persist the task id returned by the control plane after a sprint_goal
 * enqueue. Idempotent: same id can be written twice without error.
 * Returns `{ updated: true }` when the row exists, `{ updated: false }`
 * when no row matches (e.g. proposal pruned between approve and the
 * ControlPlane round-trip).
 */
export async function setResultingTaskId(
  proposalId: string,
  taskId: string,
  pool: Pool = getKgPool(),
): Promise<{ updated: boolean }> {
  const result = await pool.query(
    `UPDATE goal_proposals
        SET resulting_task_id = $2
      WHERE id = $1`,
    [proposalId, taskId],
  );
  return { updated: result.rowCount === 1 };
}

/**
 * Write the resulting PR URL and outcome back onto the proposal row that
 * spawned this task. Idempotent.
 *
 * `outcome` is one of the canonical CHECK values:
 *   - `merged` — PR landed on the base branch.
 *   - `rejected` — reviewer explicitly rejected (reserved for a future
 *     signal, not currently emitted by the merge/close path).
 *   - `closed_unmerged` — PR was closed without a merge (sprint failed
 *     after PR-open, or operator /cancel).
 *
 * Returns `{ updated: true }` when the proposal id matches a row;
 * `{ updated: false }` when no row exists.
 */
export async function setResultingPrOutcome(
  proposalId: string,
  prUrl: string,
  outcome: 'merged' | 'rejected' | 'closed_unmerged',
  pool: Pool = getKgPool(),
): Promise<{ updated: boolean }> {
  const result = await pool.query(
    `UPDATE goal_proposals
        SET resulting_pr_url = $2,
            resulting_pr_outcome = $3
      WHERE id = $1`,
    [proposalId, prUrl, outcome],
  );
  return { updated: result.rowCount === 1 };
}

/**
 * Extract the proposal id from an idempotency key of the form
 * `proposal:<id>` (the shape M5.2-T1's Approve→/ship handler uses).
 * Returns null for any other key shape so non-proposal tasks aren't
 * misclassified.
 */
export function extractProposalIdFromIdempotencyKey(
  idempotencyKey: string | null | undefined,
): string | null {
  if (!idempotencyKey) return null;
  const m = /^proposal:([A-Za-z0-9_-]+)$/.exec(idempotencyKey);
  return m ? (m[1] ?? null) : null;
}

/**
 * Read proposals for `repoId`, newest first, capped at `limit`. The
 * context-loader (T3) treats this as fail-open: a thrown read becomes `[]`
 * with a single warn line. We honour that contract by catching at the
 * boundary and returning `[]` here too — both layers warn so an operator
 * sees the root cause when the table genuinely is missing.
 */
export async function getPastProposalsByRepo(
  repoId: string,
  limit: number,
  pool: Pool = getKgPool(),
): Promise<PastProposalSummary[]> {
  try {
    const result = await pool.query<{
      id: string;
      proposed_at: Date;
      source: ProposalSource;
      title: string;
      decision: ProposalDecision | null;
      resulting_pr_outcome: GoalProposalRecord['resulting_pr_outcome'];
    }>(
      `SELECT id, proposed_at, source, title, decision, resulting_pr_outcome
         FROM goal_proposals
        WHERE repo_id = $1
        ORDER BY proposed_at DESC
        LIMIT $2`,
      [repoId, limit],
    );
    return result.rows.map((r) => ({
      id: r.id,
      proposedAt: r.proposed_at instanceof Date ? r.proposed_at.getTime() : Date.parse(String(r.proposed_at)),
      source: r.source,
      title: r.title,
      decision: r.decision,
      resultingPrOutcome: r.resulting_pr_outcome,
    }));
  } catch (err) {
    if (err instanceof KgPostgresUnavailableError) {
      console.warn(`[proposals-store] getPastProposalsByRepo: ${err.message}`);
      return [];
    }
    console.warn(
      `[proposals-store] getPastProposalsByRepo failed for ${repoId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
