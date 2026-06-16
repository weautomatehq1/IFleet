// M5.2 — confidence-gated auto-approve seam for the proposer.
//
// `runProposer()` calls `splitAndDispatch(top, cfg, deps)` after `enforceBudget`
// returns its survivor list. The split is a single filter on
// `composite_score`:
//
//   auto = top.filter(c => c.composite_score >= threshold)
//   hitl = top.filter(c => c.composite_score <  threshold)
//
// `auto` candidates go through `autoApproveProposals` — one DB insert + one
// `recordProposalDecision({decision: 'approved', decidedBy: 'auto-bandit-<t>'})`
// + one `sprint_goal` ControlCommand (idempotency `proposal:<id>`) + one
// `setResultingTaskId` write. `hitl` candidates fall through to the existing
// `postProposalsForApproval` path, where Sebastian still clicks Approve.
//
// Threshold resolution (highest priority first):
//   1. `cfg.proposalsAutoApproveThreshold` — set by the cron / tests.
//   2. env var `IFLEET_PROPOSALS_AUTO_APPROVE_THRESHOLD`.
//   3. Default `Number.POSITIVE_INFINITY` — every candidate falls into
//      `hitl`, no behavioural change vs M5.2-T1. The sentinel is strictly
//      above the scorer's `[0,1]` ceiling so the `>= threshold` filter
//      cannot match even an exact-1.0 max-out candidate.
//
// Failure semantics for the auto path:
//   - DB insert failure → log + skip that candidate; do NOT block the others.
//   - recordProposalDecision returning `{updated: false}` → log + skip the
//     control-plane post (the row vanished between insert + decision write).
//   - controlPlane.postCommand throws OR `ack.accepted === false` → log + skip
//     setResultingTaskId; do NOT block the others.
//   - setResultingTaskId failure → log; the task is already enqueued, so the
//     M5.2-T2 reverse linker (`extractProposalIdFromIdempotencyKey`) is the
//     authoritative back-edge for that case.

import { randomUUID } from 'node:crypto';

import {
  insertProposal,
  setResultingTaskId,
} from '../../orchestrator/goal-proposals-store.js';
import { recordProposalDecision } from '../../orchestrator/approval-gate.js';
import type {
  ControlCommand,
  ControlPlaneClient,
} from '../../contracts/control-plane-client.js';
import type { DedupedCandidate, ProposerConfig } from './types.js';

const AUTO_APPROVE_THRESHOLD_ENV = 'IFLEET_PROPOSALS_AUTO_APPROVE_THRESHOLD';
// Sentinel strictly above the scorer's max — the `>= threshold` filter in
// splitAndDispatch then cannot match anything. Setting this to `1.0` would
// allow a candidate that scored exactly `1.0` (worst-case maxout per the
// scorer's `0.4 + 0.3 + 0.3` ceiling) to slip past HITL on the default.
const DEFAULT_THRESHOLD = Number.POSITIVE_INFINITY;

/**
 * Resolve the effective auto-approve threshold. Exported for tests +
 * observability — the cron entry logs the value at the start of each run.
 */
export function resolveAutoApproveThreshold(cfg: ProposerConfig): number {
  if (
    typeof cfg.proposalsAutoApproveThreshold === 'number' &&
    Number.isFinite(cfg.proposalsAutoApproveThreshold)
  ) {
    return cfg.proposalsAutoApproveThreshold;
  }
  const raw = process.env[AUTO_APPROVE_THRESHOLD_ENV];
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_THRESHOLD;
}

/** Format the `decided_by` audit string for the auto path. */
export function formatAutoBanditDecidedBy(threshold: number): string {
  // Strip a single trailing zero on integer-valued thresholds so the audit
  // string reads `auto-bandit-1` rather than `auto-bandit-1.0`; otherwise
  // preserve the float for traceability (e.g. `auto-bandit-0.85`).
  if (Number.isInteger(threshold)) return `auto-bandit-${threshold}`;
  return `auto-bandit-${threshold}`;
}

export interface SplitAndDispatchDeps {
  controlPlane: ControlPlaneClient;
  /** Discord HITL path — defaults to `postProposalsForApproval` in approval-gate. */
  postProposalsForApproval: (
    candidates: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => Promise<number>;
  /** Override the auto-approve loop — tests inject. */
  autoApproveProposals?: (
    candidates: DedupedCandidate[],
    cfg: ProposerConfig,
    deps: AutoApproveDeps,
  ) => Promise<number>;
  /** Override id generation — tests pin determinism. */
  generateId?: () => string;
  /** Override `console.warn` — tests capture. */
  warn?: (line: string) => void;
}

export interface AutoApproveDeps {
  controlPlane: ControlPlaneClient;
  insertProposal?: typeof insertProposal;
  recordProposalDecision?: typeof recordProposalDecision;
  setResultingTaskId?: typeof setResultingTaskId;
  generateId?: () => string;
  warn?: (line: string) => void;
}

/**
 * Split `top` into auto + hitl by `composite_score >= threshold` and dispatch
 * each subset to its respective sink. Returns the SUM of auto-approved-and-
 * enqueued candidates plus Discord posts that landed — the same shape
 * `postProposalsForApproval` returns today, so `runProposer` can keep using
 * it as `ProposerRun.posted`.
 *
 * dryRun: when `cfg.dryRun === true`, neither sink writes — both return 0.
 * The HITL sink already honours dryRun; the auto sink short-circuits here so
 * a smoke run can't enqueue real sprints.
 */
export async function splitAndDispatch(
  top: DedupedCandidate[],
  cfg: ProposerConfig,
  deps: SplitAndDispatchDeps,
): Promise<number> {
  const warn = deps.warn ?? ((l) => console.warn(l));
  const threshold = resolveAutoApproveThreshold(cfg);
  const live = top.filter((c) => !c.dropped);
  let auto = live.filter((c) => c.composite_score >= threshold);
  let hitl = live.filter((c) => c.composite_score < threshold);

  // The orchestrator handler at src/orchestrator/handlers/control-plane.ts
  // throws on sprint_goal without channelId/userId/userLabel. Without a
  // configured `proposalsAutoApproveSource` we cannot satisfy that contract,
  // so fall through to HITL rather than letting postCommand hit a 500.
  if (auto.length > 0 && !cfg.proposalsAutoApproveSource) {
    warn(
      `[auto-approve] cfg.proposalsAutoApproveSource unset — falling ${auto.length} auto candidate(s) back to HITL`,
    );
    hitl = [...hitl, ...auto];
    auto = [];
  }

  warn(
    `[auto-approve] threshold=${threshold} auto=${auto.length} hitl=${hitl.length} dropped=${top.length - live.length}`,
  );

  const autoImpl = deps.autoApproveProposals ?? autoApproveProposals;
  const autoCount =
    auto.length > 0
      ? await autoImpl(auto, cfg, {
          controlPlane: deps.controlPlane,
          ...(deps.generateId ? { generateId: deps.generateId } : {}),
          ...(deps.warn ? { warn: deps.warn } : {}),
        })
      : 0;

  const hitlCount =
    hitl.length > 0 ? await deps.postProposalsForApproval(hitl, cfg) : 0;

  return autoCount + hitlCount;
}

/**
 * Auto-approve each candidate: insert row → record approved decision →
 * enqueue sprint_goal → back-link task id. Errors on one candidate are
 * logged and skipped so the rest of the batch still ships.
 */
export async function autoApproveProposals(
  candidates: DedupedCandidate[],
  cfg: ProposerConfig,
  deps: AutoApproveDeps,
): Promise<number> {
  const warn = deps.warn ?? ((l) => console.warn(l));
  if (cfg.dryRun) {
    warn(`[auto-approve] dry-run — skipping ${candidates.length} auto-approvals`);
    return 0;
  }
  const generateId = deps.generateId ?? (() => randomUUID());
  const insert = deps.insertProposal ?? insertProposal;
  const decide = deps.recordProposalDecision ?? recordProposalDecision;
  const linkTask = deps.setResultingTaskId ?? setResultingTaskId;

  const threshold = resolveAutoApproveThreshold(cfg);
  const decidedBy = formatAutoBanditDecidedBy(threshold);

  let enqueued = 0;
  for (const candidate of candidates) {
    const proposalId = generateId();

    try {
      await insert({
        id: proposalId,
        repo_id: cfg.repoId,
        source: candidate.source,
        title: candidate.title,
        rationale: candidate.rationale,
        estimated_value: candidate.estimated_value,
        estimated_difficulty: candidate.estimated_difficulty,
        embedding: null,
      });
    } catch (err) {
      warn(
        `[auto-approve] insertProposal failed for ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        } — skipping`,
      );
      continue;
    }

    try {
      const { updated } = await decide({
        kind: 'proposal',
        proposalId,
        decision: 'approved',
        decidedBy,
      });
      if (!updated) {
        warn(
          `[auto-approve] recordProposalDecision returned updated=false for ${proposalId} — skipping enqueue`,
        );
        continue;
      }
    } catch (err) {
      warn(
        `[auto-approve] recordProposalDecision failed for ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        } — skipping enqueue`,
      );
      continue;
    }

    // splitAndDispatch already short-circuits to HITL when this source is
    // missing, so reaching this point guarantees it's present. Asserting
    // makes that explicit for callers that bypass splitAndDispatch (tests).
    if (!cfg.proposalsAutoApproveSource) {
      warn(
        `[auto-approve] cfg.proposalsAutoApproveSource unset — skipping ${proposalId}; task NOT enqueued`,
      );
      continue;
    }
    const command: ControlCommand = {
      type: 'sprint_goal',
      goal: candidate.title,
      repo: cfg.repoId,
      idempotencyKey: `proposal:${proposalId}`,
      source: {
        kind: 'discord',
        channelId: cfg.proposalsAutoApproveSource.channelId,
        userId: cfg.proposalsAutoApproveSource.userId,
        userLabel: cfg.proposalsAutoApproveSource.userLabel,
      },
    };

    let ack;
    try {
      ack = await deps.controlPlane.postCommand(command);
    } catch (err) {
      warn(
        `[auto-approve] controlPlane.postCommand threw for ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        } — task NOT enqueued, resulting_task_id NOT written`,
      );
      continue;
    }
    if (!ack.accepted || !ack.taskId) {
      const msg = ack.message ? ` (${ack.message})` : '';
      warn(
        `[auto-approve] controlPlane refused ${proposalId}${msg} — task NOT enqueued, resulting_task_id NOT written`,
      );
      continue;
    }

    try {
      await linkTask(proposalId, ack.taskId);
    } catch (err) {
      warn(
        `[auto-approve] setResultingTaskId failed for ${proposalId} → ${ack.taskId}: ${
          err instanceof Error ? err.message : String(err)
        } — task is enqueued; M5.2-T2 reverse linker will reconcile`,
      );
      // Still counts: the sprint is queued — the broken back-edge is recoverable.
    }
    enqueued += 1;
  }
  return enqueued;
}
