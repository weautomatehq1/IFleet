// Tick loop and sprint-completion wiring.
// Extracted from daemon.ts — pure structural refactor, no logic changes.

import { UnifiedQueueAdapter } from '../../queue/unified-adapter.js';
import { Orchestrator } from '../index.js';
import type { OrchestratorEvent, SprintId } from '../types.js';
import type { QueuedTask } from '../../contracts/task.js';
import { TaskStore } from '../../queue/store.js';
import { DiscordOutAdapter } from '../../observability/discord-output.js';
import { broadcastIFleet } from '../../observability/discord-broadcast.js';
import { encodeBridgeBrief } from '../pipeline-bridge.js';
import { isFleetPaused } from '../fleet-control.js';
import type { TaskContextRegistry } from './pr-decisions.js';
import {
  recordBanditOutcomeForTask,
  recordPrDecisionMerged,
  recordPrDecisionRejected,
} from './pr-decisions.js';
import {
  extractProposalIdFromIdempotencyKey,
  setResultingPrOutcome,
} from '../goal-proposals-store.js';

/**
 * M5.2-T2: when a sprint-spawned task originated from an approved
 * proposal, push the resulting PR url + outcome back onto the
 * `goal_proposals` row so the Voyager iterative-prompting loop on the
 * next nightly run has training data ("we tried this; reviewer merged
 * it / closed it without merging").
 *
 * Fire-and-forget by design — the only signal we have that a task came
 * from a proposal is its idempotency key (`proposal:<id>`, set by
 * `enqueueApprovedProposal` in interaction-create.ts). Any DB write
 * failure here logs and returns; the PR decision was already recorded
 * via `recordPrDecision*` regardless.
 */
function recordPrOutcomeOnProposal(
  task: QueuedTask,
  prUrl: string,
  outcome: 'merged' | 'rejected' | 'closed_unmerged',
): void {
  const proposalId = extractProposalIdFromIdempotencyKey(task.idempotencyKey);
  if (!proposalId) return;
  void setResultingPrOutcome(proposalId, prUrl, outcome).catch((err) => {
    console.warn(
      `[daemon] setResultingPrOutcome(${proposalId}, ${outcome}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractPrNumber(prUrl: string): number | null {
  const m = /\/pull\/(\d+)(?:\/|$)/.exec(prUrl);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Periodically drain pending tasks from the unified store and submit each as
 * a single-task sprint to the Orchestrator. The orchestrator's pipeline
 * factory does the actual work; this loop only owns the seam between
 * "queued task" and "running sprint".
 */
export async function runTickLoop(
  adapter: UnifiedQueueAdapter,
  orchestrator: Orchestrator,
  isRunning: () => boolean,
  tickMs: number,
  store: TaskStore,
  out?: DiscordOutAdapter,
  unifiedToSprintId?: Map<string, SprintId>,
  verifierCtx?: TaskContextRegistry,
): Promise<void> {
  let lastPausedAt = false;
  while (isRunning()) {
    try {
      // Honour the fleet PAUSED flag — same flag the smoke runner cron
      // checks at the top of main(). Long-running tasks already in flight
      // are NOT killed; only new pickups are frozen. /stop is the verb that
      // kills + pauses.
      if (isFleetPaused()) {
        if (!lastPausedAt) {
          console.warn('[daemon] fleet PAUSED — skipping pickups until /continue');
          lastPausedAt = true;
        }
        await sleep(tickMs);
        continue;
      }
      if (lastPausedAt) {
        console.warn('[daemon] fleet resumed — pickups re-enabled');
        lastPausedAt = false;
      }
      const task = await adapter.pickNext();
      if (task) {
        const brief = encodeBridgeBrief(task);
        const sprintRec = orchestrator.submitSprint({
          mode: 'normal',
          goal: task.title,
          newTaskBriefs: [brief],
        });
        // Bridge the unified task ID → orchestrator sprint ID so /cancel
        // and /stop (which arrive with the unified ID) can reach the
        // SprintManager. wireSprintCompletion cleans the entry on terminal
        // sprint events.
        unifiedToSprintId?.set(task.id, sprintRec.id);
        // adapter already flipped the row to in_flight inside pickNext().
        // Wire the sprint's terminal event back to the unified queue so the
        // task row transitions out of in_flight (done / failed).
        wireSprintCompletion(
          sprintRec.id,
          task,
          adapter,
          orchestrator,
          store,
          out,
          unifiedToSprintId,
          verifierCtx,
        );
      }
    } catch (err) {
      console.warn('[daemon] tick failed:', err);
    }
    await sleep(tickMs);
  }
}

/**
 * Registers a one-shot listener on the orchestrator event bus. When the
 * sprint with {@link sprintId} reaches a terminal state (completed/failed/
 * cancelled), the corresponding unified-queue lifecycle method is called so
 * the queue task transitions out of `in_flight`. When a PR URL was captured
 * during the sprint, a {@link PrDecision} row is written to the task store:
 * verdict `'merged'` on success, `'rejected'` on failure/cancel.
 */
export function wireSprintCompletion(
  sprintId: string,
  task: QueuedTask,
  adapter: UnifiedQueueAdapter,
  orchestrator: Orchestrator,
  store: TaskStore,
  out?: DiscordOutAdapter,
  unifiedToSprintId?: Map<string, SprintId>,
  verifierCtx?: TaskContextRegistry,
): void {
  let lastPrUrl: string | undefined;
  let lastTotalTokens: number | undefined;

  const handler = (event: OrchestratorEvent): void => {
    if (event.sprintId !== sprintId) return;

    if (event.kind === 'task.assigned') {
      // Broadcast the pickup to #ifleet via webhook FIRST — this is the
      // source-agnostic notification. GitHub-source tasks have no thread,
      // so without this they were invisible until completion (or failure).
      // Webhook failures swallow internally; we never lose the event silently
      // (see broadcast-discord.ts warn-once on unset env).
      broadcastIFleet(`🟡 picked up — ${task.repo} · ${task.title}`);
      // Re-read the task from the store: the closure captured the original
      // QueuedTask before discordSource.ingest() opened a thread, so its
      // threadId may be stale (null on the snapshot, populated on the row).
      // Without this re-read, the 🟡 picked-up ping is silently skipped for
      // every task whose thread was created after ingest.
      if (out) {
        const current = store.getById(task.id);
        const threadId =
          current && current.source.kind === 'discord' ? current.source.threadId : undefined;
        if (threadId) {
          void out
            .postProgress(threadId, '🟡 picked up — architect starting')
            .catch(() => {});
        }
      }
      return;
    }

    if (event.kind === 'task.completed') {
      lastPrUrl = event.payload['pr'] as string | undefined;
      lastTotalTokens = event.payload['totalTokens'] as number | undefined;
      // Broadcast PR open to #ifleet via webhook (source-agnostic). Mirror
      // the per-thread post below for Discord-source tasks.
      if (lastPrUrl) {
        broadcastIFleet(`✅ PR opened: ${lastPrUrl} — ${task.repo} · ${task.title}`);
      } else {
        // (AUDIT-IFleet-4d424525) Be explicit about the "no PR" case. The
        // pipeline short-circuits to `already_resolved` / `no_changes_needed`
        // when the editor verified the fix was already in place — that's a
        // success, not a silent failure. Surface that to the operator.
        const reason = (event.payload['failureReason'] as string | undefined) ?? 'no changes needed';
        broadcastIFleet(`✅ task completed — ${task.repo} · ${task.title} (no PR: ${reason})`);
      }
      // Thread-level completion post is owned by Orchestrator.dispatchToDiscord
      // (`out.postCompleted`) which fires on every `task.completed` event for
      // Discord-source tasks with a resolved thread. Posting again here would
      // double the per-thread message. AUDIT-IFleet-b4ad2ed4. The
      // broadcastIFleet ping above is the source-agnostic notification and
      // doesn't duplicate the per-thread post.
      return;
    }

    if (event.kind === 'sprint.completed') {
      orchestrator.off('event', handler);
      unifiedToSprintId?.delete(task.id);

      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          // M4-T5: compute structural fingerprint of the merged diff so
          // PR-rejection learning can detect structural repeats across
          // sprints. Snapshot the verifier ctx BEFORE the delete() below so
          // the async chain sees a worktreePath even if teardown removed
          // the registry entry concurrently. Failure-graceful: any compute
          // throw falls back to null fingerprint and the row is still
          // inserted (per M4-T5 contract).
          const ctx = verifierCtx?.get(task.id);
          void recordPrDecisionMerged(store, task, prNumber, ctx);
          recordBanditOutcomeForTask(store, task, true);
          recordPrOutcomeOnProposal(task, lastPrUrl, 'merged');
        }
      }
      verifierCtx?.delete(task.id);

      void adapter.markCompleted(task, lastPrUrl ?? '', lastTotalTokens).catch((err) =>
        console.warn('[daemon] markCompleted failed:', err),
      );
      return;
    }

    if (event.kind === 'sprint.failed' || event.kind === 'sprint.cancelled') {
      orchestrator.off('event', handler);
      unifiedToSprintId?.delete(task.id);
      // M4-T5: snapshot the verifier ctx BEFORE the cancellation path
      // deletes it below — the fingerprint compute below needs the
      // worktreePath, and sprint.cancelled evicts the registry entry
      // synchronously here.
      const ctxSnapshot = verifierCtx?.get(task.id);
      // `cancelled`: evict immediately — no /force-pr path follows a cancel.
      // `failed`: schedule a delayed eviction (60 min) so the operator's
      // /force-pr call inside that window still resolves repoUrl/branch/
      // worktreePath, but the entry doesn't leak for the life of the daemon.
      // Without the delayed eviction the map grew monotonically across every
      // failed sprint. AUDIT-IFleet-44d12a0d / dae6c0e6.
      if (event.kind === 'sprint.cancelled') {
        verifierCtx?.delete(task.id);
      } else {
        setTimeout(() => verifierCtx?.delete(task.id), 60 * 60 * 1000).unref();
      }
      // sprint.failed / sprint.cancelled events carry only { from, to } in
      // payload — the actual error/reason lives on SprintState. Read it from
      // the store via the orchestrator instead of trusting the payload.
      const sprint = orchestrator.getSprint(sprintId as SprintId);
      const reason =
        sprint?.state.kind === 'failed'
          ? sprint.state.error
          : sprint?.state.kind === 'cancelled'
            ? sprint.state.reason
            : event.kind === 'sprint.failed'
              ? 'pipeline failed'
              : 'cancelled';

      // Broadcast the terminal state to #ifleet via webhook BEFORE markFailed
      // touches the issue — this is the gap that let token-burn go silent.
      // Use the same wire format the smoke runner uses so the channel reads
      // consistently regardless of who dispatched the task.
      const verb = event.kind === 'sprint.cancelled' ? '🛑 cancelled' : '❌ failed';
      broadcastIFleet(`${verb} — ${task.repo} · ${task.title}\n${reason}`);

      // Only record a decision when a PR was opened before the failure/cancel.
      if (lastPrUrl) {
        const prNumber = extractPrNumber(lastPrUrl);
        if (prNumber !== null) {
          // M4-T5: sprint.failed/cancelled with a PR open => the PR was
          // closed without merging => verdict='rejected'. Same async
          // fingerprint compute as the merged path; null on any failure.
          void recordPrDecisionRejected(store, task, prNumber, ctxSnapshot);
          recordBanditOutcomeForTask(store, task, false);
          // M5.2-T2: outcome distinct from verdict — pr_decisions tracks
          // architect-side learning (rejected), proposal tracks
          // human-visible outcome (closed_unmerged) so the Voyager loop
          // doesn't conflate "verifier closed PR before reviewer saw it"
          // with "reviewer rejected the merged proposal."
          recordPrOutcomeOnProposal(task, lastPrUrl, 'closed_unmerged');
        }
      }

      // AUDIT-IFleet-3db72bd3 / 7b13a148: split the terminal path so a
      // deliberate cancel is NOT recorded as 'failed' in the unified store.
      // sprint.cancelled → markCancelled (store: 'blocked'+cancelled:true)
      // sprint.failed   → markFailed    (store: 'failed')
      if (event.kind === 'sprint.cancelled') {
        void adapter.markCancelled(task, reason).catch((err) =>
          console.warn('[daemon] markCancelled failed:', err),
        );
      } else {
        void adapter.markFailed(task, reason).catch((err) =>
          console.warn('[daemon] markFailed failed:', err),
        );
      }
    }
  };

  orchestrator.on('event', handler);
}
