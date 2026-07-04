// M5 Proposer — orchestration entry point.
//
// `runProposer()` is the single-trace nightly entrypoint (ADR-0001 — one
// runProposer call per nightly run, no fan-out). It sequences:
//
//   context-loader → candidate-gen (T4) → dedupe (T4) → scorer (T4)
//                  → budget (T4) → approval-gate / Discord (T5)
//
// T4 and T5 own the modules being called; until they land, those modules
// throw from their stub bodies. The runner uses dependency-injection seams
// so the skeleton tests can mock every stage and verify the call sequence.

import { randomUUID } from 'node:crypto';

import { loadProposerContext, type ContextLoaderDeps } from './context-loader.js';
import { generateCandidates as generateCandidatesImpl } from './candidate-gen.js';
import { dedupeCandidates as dedupeCandidatesImpl } from './dedupe.js';
import { scoreCandidates as scoreCandidatesImpl } from './scorer.js';
import { enforceBudget as enforceBudgetImpl } from './budget.js';
import { postProposalsForApproval as postProposalsForApprovalImpl } from './approval-gate.js';
import { splitAndDispatch as splitAndDispatchImpl } from './auto-approve.js';
import type { ControlPlaneClient } from '../../contracts/control-plane-client.js';
import type {
  Candidate,
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
  ProposerRun,
} from './types.js';

/**
 * Stage-level seams. Production wires every field to the real T4/T5 module;
 * tests replace each with a spy. Splitting these as an interface means the
 * orchestrator's test can assert "candidate-gen was called BEFORE dedupe was
 * called" by inspecting the order in which mocks fired.
 */
export interface ProposerStages {
  loadContext?: (
    repoId: string,
    cfg: ProposerConfig,
  ) => Promise<ProposerContext>;
  generateCandidates?: (
    ctx: ProposerContext,
    cfg: ProposerConfig,
  ) => Promise<Candidate[]>;
  dedupeCandidates?: (
    candidates: Candidate[],
    ctx: ProposerContext,
    cfg: ProposerConfig,
  ) => Promise<DedupedCandidate[]>;
  scoreCandidates?: (
    candidates: DedupedCandidate[],
    ctx: ProposerContext,
    cfg: ProposerConfig,
  ) => Promise<DedupedCandidate[]>;
  enforceBudget?: (
    scored: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => DedupedCandidate[] | Promise<DedupedCandidate[]>;
  postProposalsForApproval?: (
    top: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => Promise<number>;
  /**
   * Final dispatch — splits `top` into auto-approve vs Discord-HITL by
   * `composite_score >= cfg.proposalsAutoApproveThreshold` and dispatches each
   * subset. Default impl is `splitAndDispatch` (see auto-approve.ts), wired
   * with the orchestrator's ControlPlaneClient + the HITL stage above.
   */
  dispatchProposals?: (
    top: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => Promise<number>;
}

export interface RunProposerDeps {
  /**
   * HMAC client to the control plane. Required when the auto-approve path
   * fires (i.e. when any candidate's composite_score crosses the threshold).
   * The cron entry (`scripts/proposer-run.ts`) wires an `HmacControlPlaneClient`;
   * tests inject a spy.
   */
  controlPlane?: ControlPlaneClient;
}

export interface RunProposerOptions {
  /** Stage overrides — test hook. Production omits all fields. */
  stages?: ProposerStages;
  /** Read-side deps for the context loader. */
  contextDeps?: ContextLoaderDeps;
  /** Cross-cutting deps shared across stages (e.g. ControlPlaneClient). */
  deps?: RunProposerDeps;
}

/**
 * Run one Proposer pass for `repoId`. Returns the run record on success.
 *
 * Throwing semantics: any stage that throws bubbles up — the caller (cron
 * wrapper) is expected to log + exit non-zero. Context loading itself is
 * fail-open and never throws, so the first throw site is candidate-gen
 * upward.
 */
export async function runProposer(
  repoId: string,
  cfg: ProposerConfig,
  opts: RunProposerOptions = {},
): Promise<ProposerRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const stages = opts.stages ?? {};
  const loadContext = stages.loadContext ?? defaultLoadContext(opts.contextDeps);
  const generateCandidates = stages.generateCandidates ?? generateCandidatesImpl;
  const dedupeCandidates = stages.dedupeCandidates ?? dedupeCandidatesImpl;
  const scoreCandidates = stages.scoreCandidates ?? scoreCandidatesImpl;
  const enforceBudget = stages.enforceBudget ?? enforceBudgetImpl;
  const postProposalsForApproval =
    stages.postProposalsForApproval ?? postProposalsForApprovalImpl;
  const dispatchProposals =
    stages.dispatchProposals ??
    defaultDispatchProposals(postProposalsForApproval, opts.deps);

  const ctx = await loadContext(repoId, cfg);
  const candidates = await generateCandidates(ctx, cfg);
  const deduped = await dedupeCandidates(candidates, ctx, cfg);
  const scored = await scoreCandidates(deduped, ctx, cfg);
  const top = await enforceBudget(scored, cfg);
  const posted = await dispatchProposals(top, cfg);

  const finishedAt = new Date().toISOString();
  return {
    runId,
    startedAt,
    finishedAt,
    repoId,
    candidates: top,
    posted,
  };
}

function defaultLoadContext(
  contextDeps: ContextLoaderDeps | undefined,
): (repoId: string, cfg: ProposerConfig) => Promise<ProposerContext> {
  return (repoId, cfg) => loadProposerContext(repoId, cfg, contextDeps);
}

function defaultDispatchProposals(
  postProposalsForApproval: (
    top: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => Promise<number>,
  deps: RunProposerDeps | undefined,
): (top: DedupedCandidate[], cfg: ProposerConfig) => Promise<number> {
  return async (top, cfg) => {
    const controlPlane = deps?.controlPlane;
    if (!controlPlane) {
      // No control plane wired (cron started before the daemon, or operator
      // ran a smoke test) — fall back to the legacy HITL-only path. The
      // auto-approve filter never fires; every candidate goes to Discord.
      console.warn(
        '[proposer] no ControlPlaneClient injected — auto-approve disabled for this run',
      );
      return postProposalsForApproval(top, cfg);
    }
    return splitAndDispatchImpl(top, cfg, {
      controlPlane,
      postProposalsForApproval,
    });
  };
}
