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

import { loadProposerContext, type ContextLoaderDeps } from './context-loader.ts';
import { generateCandidates as generateCandidatesImpl } from './candidate-gen.ts';
import { dedupeCandidates as dedupeCandidatesImpl } from './dedupe.ts';
import { scoreCandidates as scoreCandidatesImpl } from './scorer.ts';
import { enforceBudget as enforceBudgetImpl } from './budget.ts';
import { postProposalsForApproval as postProposalsForApprovalImpl } from './approval-gate.ts';
import type {
  Candidate,
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
  ProposerRun,
} from './types.ts';

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
  ) => Promise<DedupedCandidate[]>;
  postProposalsForApproval?: (
    top: DedupedCandidate[],
    cfg: ProposerConfig,
  ) => Promise<number>;
}

export interface RunProposerOptions {
  /** Stage overrides — test hook. Production omits all fields. */
  stages?: ProposerStages;
  /** Read-side deps for the context loader. */
  contextDeps?: ContextLoaderDeps;
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

  const ctx = await loadContext(repoId, cfg);
  const candidates = await generateCandidates(ctx, cfg);
  const deduped = await dedupeCandidates(candidates, ctx, cfg);
  const scored = await scoreCandidates(deduped, ctx, cfg);
  const top = await enforceBudget(scored, cfg);
  const posted = await postProposalsForApproval(top, cfg);

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
