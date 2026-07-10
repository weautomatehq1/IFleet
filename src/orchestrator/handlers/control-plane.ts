// Control-plane callback factory.
// Extracted from daemon.ts — pure structural refactor, no logic changes.
// buildControlPlaneOptions() takes all runtime deps and returns the on* callbacks
// for createControlPlane(), keeping daemon.ts's main() a thin wiring entry point.

import { Octokit } from '@octokit/rest';
import { broadcastIFleet } from '../../observability/discord-broadcast.js';
import { DiscordSource } from '@wahq/orchestrator-core/queue/sources/discord';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import { StateStore } from '../store.js';
import { Orchestrator } from '../index.js';
import { VerifierController } from '../../agents/verifier/controller.js';
import type { SprintId, TaskId } from '../types.js';
import type { ControlPlaneOptions } from '@wahq/orchestrator-core/queue/control-plane';
import {
  clearFleetPause,
  isFleetPaused,
  readPauseInfo,
  setFleetPaused,
} from '../fleet-control.js';
import { handleForcePr, type TaskContextRegistry } from './pr-decisions.js';
import { ControlPlaneApprovalGate } from '../approval-gate.js';

export interface ControlPlaneDeps {
  store: TaskStore;
  orchestratorStore: StateStore;
  approvalGate: ControlPlaneApprovalGate;
  discordSource: DiscordSource;
  orchestrator: Orchestrator;
  verifierController: VerifierController;
  verifierCtx: TaskContextRegistry;
  unifiedToSprintId: Map<string, SprintId>;
  octokit: Pick<Octokit, 'rest'>;
}

type ControlPlaneCallbacks = Pick<
  ControlPlaneOptions,
  | 'onSprintGoal'
  | 'onApprove'
  | 'onVerify'
  | 'onForcePr'
  | 'onCancel'
  | 'onPause'
  | 'onContinue'
  | 'onStop'
  | 'onStatus'
>;

export function buildControlPlaneOptions(deps: ControlPlaneDeps): ControlPlaneCallbacks {
  const {
    store,
    orchestratorStore,
    approvalGate,
    discordSource,
    orchestrator,
    verifierController,
    verifierCtx,
    unifiedToSprintId,
    octokit,
  } = deps;

  return {
    onSprintGoal: async (cmd) => {
      if (!cmd.channelId || !cmd.userId || !cmd.userLabel) {
        throw new Error('sprint_goal requires Discord-source fields (channelId, userId, userLabel)');
      }
      // Slash commands carry only an interaction.id, not a messageId — T1
      // sends idempotencyKey instead. Require at least one of the two so
      // dedup is always anchored to a stable client-side identifier.
      if (!cmd.messageId && !cmd.idempotencyKey) {
        throw new Error('sprint_goal requires messageId or idempotencyKey for dedup');
      }
      const task = await discordSource.ingest(
        {
          goal: cmd.goal,
          channelId: cmd.channelId,
          ...(cmd.messageId ? { messageId: cmd.messageId } : {}),
          userId: cmd.userId,
          userLabel: cmd.userLabel,
          ...(cmd.idempotencyKey ? { idempotencyKey: cmd.idempotencyKey } : {}),
          ...(cmd.planOnly ? { planOnly: cmd.planOnly } : {}),
          ...(cmd.repo ? { repo: cmd.repo } : {}),
        },
        store,
      );
      return {
        taskId: task.id,
        ...(task.source.kind === 'discord' && task.source.threadId
          ? { threadId: task.source.threadId }
          : {}),
      };
    },

    onApprove: async (taskId) => {
      approvalGate.resolve(taskId, 'approve');
    },

    onVerify: async (taskId) => {
      void verifierController.verifyManual(taskId as TaskId).catch((err) =>
        console.warn('[daemon] verifyManual failed:', err),
      );
    },

    onForcePr: async (taskId, reason) => {
      await handleForcePr(taskId, reason, {
        store,
        orchestratorStore,
        unifiedToSprintId,
        verifierCtx,
        octokit,
      });
    },

    onCancel: async (taskId, reason) => {
      // Resolve `__channel_current__:<channelId>` sentinel emitted by
      // /cancel-with-no-arg. Picks the most recently-created in-flight task
      // in that channel (mirrors how /status defaults to the same channel).
      let resolvedId = taskId;
      if (taskId.startsWith('__channel_current__:')) {
        const channelId = taskId.slice('__channel_current__:'.length);
        if (!/^\d{17,20}$/.test(channelId)) {
          console.warn('[daemon] onCancel: invalid channelId in sentinel:', channelId);
          return;
        }
        const candidates = store.list({ channelId, state: 'in_flight' }, 1);
        if (candidates.length === 0) {
          broadcastIFleet(`⚠ /cancel — no in-flight task in <#${channelId}> to cancel.`);
          return;
        }
        resolvedId = candidates[0]!.id;
      }
      // TOCTOU guard (AUDIT-IFleet-42408e04): re-read the task right before
      // mutating it. If it already completed or failed between sentinel
      // resolution and now, do nothing — overwriting `completed` → `failed`
      // would diverge queue state from reality (the PR is already open).
      const current = store.getById(resolvedId);
      if (current && current.state !== 'in_flight' && current.state !== 'pending') {
        broadcastIFleet(
          `⚠ /cancel — task \`${resolvedId}\` already \`${current.state}\`; nothing to do.`,
        );
        return;
      }
      // Flip the in-flight state to a terminal cancel state first so the
      // picked-up state resolves before the architect handles cancel — keeps
      // the store consistent if the architect is still mid-spawn.
      //
      // AUDIT-IFleet-3db72bd3 / 7b13a148: a deliberate operator /cancel is NOT
      // a pipeline failure. Recording 'failed' here polluted failure metrics
      // and risked failure-driven retry/backoff treating an intentional stop
      // as a crash. The TaskState enum (src/contracts/task.ts) has no
      // 'cancelled' member and that contract is owned by another lane, so we
      // record the existing terminal-ish 'blocked' state — which pickNext()
      // (pending-only) and recoverStale() (in_flight-only) both leave
      // untouched, so it is never auto-retried — and tag the meta with
      // cancelled:true so metrics/consumers can tell a deliberate cancel apart
      // from a capability block.
      try {
        store.updateState(resolvedId, 'blocked', {
          reason: reason ?? 'cancelled via control plane',
          cancelled: true,
        });
      } catch {
        /* row may not exist yet */
      }
      approvalGate.resolve(resolvedId, 'cancel');
      // Actually abort the running pipeline worker (AUDIT-IFleet-7dd1062f).
      // approvalGate.resolve only unblocks a pipeline waiting at HITL; the
      // SprintManager's cancelSprint walks `running` and calls handle.cancel()
      // which in turn calls abortController.abort() — that's what kills the
      // editor/verifier/reviewer mid-spawn.
      //
      // PR #211 looked up `orchestratorStore.loadTask(resolvedId)` here, but
      // the orchestrator store is keyed by `tk_<nanoid>` IDs (sprint.ts:170)
      // while resolvedId is the unified store's ULID/node_id — the lookup
      // always returned undefined and cancelSprint was never called. The
      // unifiedToSprintId map is populated from wireSprintCompletion (which
      // owns both IDs) so this lookup hits in O(1). AUDIT-IFleet-15443528,
      // ea8d8b2f, 67942487, 11a51d4c.
      try {
        const sprintId = unifiedToSprintId.get(resolvedId);
        if (sprintId) {
          await orchestrator.cancelSprint(sprintId, reason ?? 'cancelled via control plane');
        }
      } catch (err) {
        console.warn('[daemon] onCancel: orchestrator.cancelSprint failed:', err);
      }
      broadcastIFleet(`🛑 /cancel — task \`${resolvedId}\` cancelled${reason ? ` — ${reason}` : ''}.`);
    },

    onPause: async (cmd) => {
      const opts: { reason?: string; by?: string } = {};
      if (cmd.reason) opts.reason = cmd.reason;
      if (cmd.userLabel) opts.by = cmd.userLabel;
      setFleetPaused(opts);
      const info = readPauseInfo();
      broadcastIFleet(
        `⏸ Fleet PAUSED${info.by ? ` by ${info.by}` : ''}${info.reason ? ` — ${info.reason}` : ''}. ` +
          `Running task continues; no new pickups until /continue.`,
      );
    },

    onContinue: async (cmd) => {
      const was = isFleetPaused();
      clearFleetPause();
      if (was) {
        broadcastIFleet(`▶ Fleet RESUMED${cmd.userLabel ? ` by ${cmd.userLabel}` : ''}.`);
      } else {
        broadcastIFleet(`▶ /continue — fleet was not paused${cmd.userLabel ? ` (by ${cmd.userLabel})` : ''}.`);
      }
    },

    onStop: async (cmd) => {
      // (AUDIT-IFleet-7dd1062f) /stop must actually abort running workers,
      // not just flip store state. orchestrator.cancelSprint walks the
      // SprintManager's `running` map and fires each handle.cancel() →
      // PipelineBridge → abortController.abort(). The pipeline runner
      // checks abortSignal between phases (architect/editor/verifier/
      // reviewer) and exits cleanly without producing a PR. Store state
      // and approvalGate.resolve(cancel) are kept for the case where a
      // sprint is queued/planning (not in `running`) — abort is a no-op
      // there, but the state flip still terminates it.
      const reason = cmd.reason ?? 'fleet stopped';
      // Snapshot the running sprints AND the unified→sprint reverse index
      // BEFORE flipping the pause flag (AUDIT-IFleet-07b8a597) and before any
      // await. JS is single-threaded so the synchronous block is atomic with
      // respect to wireSprintCompletion eviction; capturing them here also
      // makes the ordering invariant explicit for future readers.
      const runningSprints = orchestratorStore.listSprintsByStateKind('running');
      // Reverse-index the unified→sprint map so we can find every unified
      // task ID attached to a sprint we're about to cancel. The orchestrator
      // store keys tasks by `tk_<nanoid>` (sprint.ts:170) which is the wrong
      // namespace for both store.updateState and approvalGate.resolve, both
      // of which are keyed by the unified ID. AUDIT-IFleet-b98f11ed,
      // 0920cd46, 0aaad39f.
      const sprintToUnified = new Map<string, string[]>();
      for (const [unifiedId, sprintId] of unifiedToSprintId.entries()) {
        const bucket = sprintToUnified.get(sprintId) ?? [];
        bucket.push(unifiedId);
        sprintToUnified.set(sprintId, bucket);
      }

      // Pause flag last in the synchronous prelude (AUDIT-IFleet-1cdaccd5):
      // the tick loop cannot pick up new work once this is set, and the snapshot
      // above is now stable for the await window below.
      const opts: { reason?: string; by?: string } = { reason: cmd.reason ?? 'STOP' };
      if (cmd.userLabel) opts.by = cmd.userLabel;
      setFleetPaused(opts);

      let cancelledTasks = 0;
      let cancelledSprints = 0;
      const sprintCancels: Promise<unknown>[] = [];
      for (const sprint of runningSprints) {
        try {
          for (const unifiedId of sprintToUnified.get(sprint.id) ?? []) {
            try {
              // AUDIT-IFleet-3db72bd3 / 7b13a148: /stop is a deliberate
              // operator action, not a failure. Record the terminal-ish
              // 'blocked' state with cancelled:true (see onCancel above) so an
              // intentional fleet stop does not pollute failure metrics or
              // trip failure-driven retry/backoff.
              store.updateState(unifiedId, 'blocked', { reason, cancelled: true });
            } catch {
              /* unified row may already be terminal — leave it */
            }
            approvalGate.resolve(unifiedId, 'cancel');
            cancelledTasks++;
          }
          cancelledSprints++;
          sprintCancels.push(
            orchestrator.cancelSprint(sprint.id, reason).catch((err: unknown) =>
              console.warn(`[daemon] onStop: cancelSprint ${sprint.id} failed:`, err),
            ),
          );
        } catch (err) {
          console.warn('[daemon] onStop: sprint cancel iteration failed:', err);
        }
      }
      await Promise.allSettled(sprintCancels);
      // Report sprint count (the architectural unit) AND task count so a
      // future multi-brief-per-sprint world stays diagnosable.
      // AUDIT-IFleet-f751e1f1.
      broadcastIFleet(
        `🛑 Fleet STOPPED${cmd.userLabel ? ` by ${cmd.userLabel}` : ''}${cmd.reason ? ` — ${cmd.reason}` : ''}. ` +
          `Aborted ${cancelledSprints} sprint(s) / ${cancelledTasks} task(s); queue paused. ` +
          `Use /continue to resume pickups.`,
      );
    },

    onStatus: (taskId) => {
      if (taskId.startsWith('__channel__:')) {
        const channelId = taskId.slice('__channel__:'.length);
        if (!/^\d{17,20}$/.test(channelId)) return null;
        const tasks = store.list({ channelId }, 5);
        if (tasks.length === 0) return `No recent tasks in <#${channelId}>.`;
        return tasks
          .map((t) => `\`${t.id}\` [${t.state ?? '?'}] — ${t.title.slice(0, 60)}`)
          .join('\n');
      }
      const task = store.getById(taskId);
      if (!task) return `No task found with id \`${taskId}\`.`;
      const lines = [
        `id: ${task.id}`,
        `state: ${task.state ?? 'unknown'}`,
        `title: ${task.title.slice(0, 100)}`,
        `repo: ${task.repo}`,
      ];
      if (task.stateMeta?.['sprintId']) lines.push(`sprint: ${String(task.stateMeta['sprintId'])}`);
      return lines.join('\n');
    },
  };
}
