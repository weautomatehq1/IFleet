// In-memory bridge between ControlPlane button events (Discord) and the
// pipeline's architect approval step. The architect calls
// `awaitApproval({ taskId, ... })`; the daemon wires ControlPlane's
// `onApprove` / `onCancel` callbacks to `resolveApproval` / `resolveCancel`.
//
// M5 (`kind: 'proposal'`): the goal-proposer reuses this module for HITL on
// Discord-posted candidates via the `recordProposalDecision` export below.
// Proposal decisions are NOT in-process awaits — they persist to
// `goal_proposals` (see `goal-proposals-store.ts`) so a Discord click an
// hour later still resolves the right row. The proposer pipeline ends at
// "post to Discord"; Approve → /ship enqueue is M5.2 follow-up.

import type { Pool } from 'pg';

import type { ApprovalGate } from '../pipeline/types.js';
import {
  recordProposalDecision as recordProposalDecisionInDb,
  type RecordDecisionResult,
} from './goal-proposals-store.js';
import type { ProposalDecision } from '../agents/proposer/types.js';

type Verdict = 'approve' | 'reject' | 'cancel';

interface Pending {
  resolve: (verdict: Verdict) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
}

export class ControlPlaneApprovalGate implements ApprovalGate {
  private readonly pending = new Map<string, Pending>();

  /**
   * Suspend the architect until a verdict is observed for `taskId`. Returns
   * `true` for approve, `false` for reject/cancel/timeout/abort. If called
   * again for the same taskId before the first await resolves, the first
   * caller is cancelled (resolved false) before the new await is registered.
   */
  async awaitApproval(opts: {
    taskId: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  }): Promise<boolean> {
    if (opts.abortSignal.aborted) return false;

    // Evict any existing waiter for this taskId so its Promise doesn't leak.
    const displaced = this.pending.get(opts.taskId);
    if (displaced) {
      displaced.resolve('cancel');
    }

    return new Promise<boolean>((resolve) => {
      const settle = (verdict: Verdict): void => {
        const entry = this.pending.get(opts.taskId);
        if (!entry) return;
        clearTimeout(entry.timer);
        opts.abortSignal.removeEventListener('abort', entry.onAbort);
        this.pending.delete(opts.taskId);
        resolve(verdict === 'approve');
      };

      const onAbort = (): void => settle('cancel');
      const timer = setTimeout(() => settle('cancel'), opts.timeoutMs);

      this.pending.set(opts.taskId, {
        resolve: settle,
        timer,
        onAbort,
      });
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Resolve a pending approval with the given verdict. No-op if unknown. */
  resolve(taskId: string, verdict: Verdict): void {
    const entry = this.pending.get(taskId);
    if (!entry) return;
    entry.resolve(verdict);
  }

  /** True if `taskId` is currently waiting on a verdict. */
  has(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  /** Resolve every pending awaiter as cancelled. Used during graceful shutdown. */
  drain(): void {
    for (const taskId of Array.from(this.pending.keys())) {
      this.resolve(taskId, 'cancel');
    }
  }
}

/**
 * Discriminator used by callers that handle both architect plans and
 * Goal-Proposer proposals. Architect plans still flow through
 * `ControlPlaneApprovalGate.resolve(taskId, verdict)`; proposals flow
 * through `recordProposalDecision` and persist to `goal_proposals`.
 */
export type ApprovalKind = 'plan' | 'proposal';

export interface ProposalDecisionInput {
  kind: 'proposal';
  proposalId: string;
  decision: ProposalDecision;
  decidedBy: string;
  /** Override the DB layer's pool — tests inject a stub. */
  pool?: Pool;
}

/**
 * Persist a Discord-button verdict against `goal_proposals` for the M5
 * proposer. Approve / Reject / Defer all land here; `expired` is reserved
 * for a future GC sweep, not a Discord button.
 *
 * Returns the DB layer's `{ updated }` so the button handler can reply
 * "Recorded" vs "No matching proposal" without a second round-trip.
 */
export async function recordProposalDecision(
  input: ProposalDecisionInput,
): Promise<RecordDecisionResult> {
  const payload = {
    proposalId: input.proposalId,
    decision: input.decision,
    decidedBy: input.decidedBy,
  };
  return input.pool
    ? recordProposalDecisionInDb(payload, input.pool)
    : recordProposalDecisionInDb(payload);
}
