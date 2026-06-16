// M5 Proposer — shared types contract.
//
// This file is the CONTRACT GATE between T3 (skeleton), T4 (candidate-gen /
// dedupe / scorer / budget), and T5 (approval-gate extension + goal_proposals
// table). T4 and T5 import every symbol below by exact name — renaming costs a
// coordination round. If you need to change the surface, also update the
// `## Exports T4 will call` and `## Exports T5 will call` subsections in
// T3-done.md so downstream lanes can re-grep.
//
// Spec source-of-truth: docs/elevation/upgrades/06-goal-driven.md
// Single-trace constraint: ADR-0001 — one runProposer() call per nightly run.

/**
 * Source of a candidate goal. Matches the `source` column on the
 * `goal_proposals` table (see T5 migration). The values mirror the bullet
 * list in upgrades/06-goal-driven.md §"Pipeline step → Generate candidates".
 */
export type ProposalSource =
  | 'sprint_gap'
  | 'learnings'
  | 'drift'
  | 'error_log'
  | 'coherence';

/**
 * Decision recorded by Sebastian in Discord when a proposal is surfaced. Mirrors
 * the `decision` column on `goal_proposals`. `null` until the HITL gate fires.
 */
export type ProposalDecision = 'approved' | 'rejected' | 'deferred' | 'expired';

/**
 * Outcome of the PR that resulted from an approved proposal — feeds the
 * Voyager iterative-prompting loop on the next nightly run. `null` until CI/PR
 * lifecycle completes.
 */
export type ProposalPrOutcome = 'merged' | 'rejected' | 'closed_unmerged';

/**
 * Compact view of a doctor fingerprint that the context-loader hands to
 * candidate-gen. We do not re-export the full `Fingerprint` shape from
 * `src/pipeline/fingerprints.ts` so the proposer module stays free of an
 * inbound coupling on the pipeline package.
 */
export interface DoctorFingerprintSummary {
  hash: string;
  tag: string;
  count: number;
  first_seen: string;
  last_fix_commit?: string;
}

/**
 * Compact view of a recent PR decision used by candidate-gen to learn what
 * passed / what got rejected. Mirrors `PrDecision` from
 * `src/queue/store.ts` minus internal SQLite ids.
 */
export interface PrDecisionSummary {
  taskId: string;
  prNumber: number;
  verdict: 'merged' | 'rejected' | 'abandoned';
  reviewerLogin: string | null;
  mergedAt: number | null;
  createdAt: number;
  fingerprint: string | null;
}

/**
 * Compact view of a past proposal — fed back into the next nightly run so the
 * Proposer can "see what we tried." Owned by T5 (the `goal_proposals` table
 * landing migration); read-only here.
 */
export interface PastProposalSummary {
  id: string;
  proposedAt: number;
  source: ProposalSource;
  title: string;
  decision: ProposalDecision | null;
  resultingPrOutcome: ProposalPrOutcome | null;
}

/**
 * The full context bundle that candidate-gen consumes. Designed to surface
 * every signal the LLM needs as plain data; candidate-gen MUST NOT make
 * further DB / filesystem calls.
 */
export interface ProposerContext {
  repoId: string;
  /** Absolute path to the repo root on disk. */
  repoRoot: string;
  /** Verbatim text of `<repoRoot>/SPRINT.md`, or empty string if missing. */
  sprintMd: string;
  /** Verbatim text of `<repoRoot>/ROADMAP.md`, or empty string if missing. */
  roadmapMd: string;
  /** Verbatim text of `<repoRoot>/NON_GOALS.md`, or empty string if missing. */
  nonGoalsMd: string;
  /** Recent tail of `<repoRoot>/.omc/learnings.md`, one entry per array slot. */
  learnings: string[];
  /** Doctor fingerprints seen in the past `cfg.windowDays` days. */
  recentDoctorFingerprints: DoctorFingerprintSummary[];
  /** PR decisions for this repo over the past 30d. */
  recentPrDecisions: PrDecisionSummary[];
  /** Proposals made over the past 30d, with their decisions + outcomes. */
  pastProposals: PastProposalSummary[];
  /** UTC ISO timestamp at the moment the context was loaded. */
  loadedAt: string;
}

/**
 * A raw candidate goal — the output of candidate-gen (T4) before scoring or
 * dedup. `estimated_value` / `estimated_difficulty` are both in [0,1] per
 * upgrades/06-goal-driven.md.
 */
export interface Candidate {
  title: string;
  rationale: string;
  estimated_value: number;
  estimated_difficulty: number;
  source: ProposalSource;
}

/**
 * Candidate after the scorer (T4) attaches alignment + composite score. The
 * scorer is purely additive — it must not drop fields from `Candidate`.
 */
export interface ScoredCandidate extends Candidate {
  /** Cosine-or-rubric alignment score against SPRINT.md / ROADMAP.md. [0,1]. */
  sprint_alignment: number;
  /** Combined value/difficulty/alignment score the budget gate sorts on. */
  composite_score: number;
}

/**
 * Candidate after dedup (T4). `dropped: true` carries a `reason` and is
 * preserved in the run record for observability — budget.ts filters dropped
 * entries before posting.
 */
export interface DedupedCandidate extends ScoredCandidate {
  /** Max cosine similarity against the last 30d of proposals. [0,1]. */
  nearest_neighbor_sim: number;
  /** True when dedup or scoring rejected this candidate. */
  dropped: boolean;
  /** Reason text — only populated when `dropped === true`. */
  reason?: string;
}

/**
 * Per-repo configuration for a single Proposer run. Surfaced via env vars at
 * the cron entry point; the orchestrator passes a frozen copy down to every
 * stage so no stage mutates shared state.
 */
export interface ProposerConfig {
  /** GitHub `owner/name` slug — also the FK into `goal_proposals.repo_id`. */
  repoId: string;
  /** Absolute path to the repo on the filesystem. */
  repoRoot: string;
  /** Daily PR budget. Default 3; hard ceiling enforced by `hardMax`. */
  budget: number;
  /** Hard ceiling on `budget` — spec default is 10. */
  hardMax: number;
  /** Doctor-fingerprint lookback window (days). Spec default is 7. */
  windowDays: number;
  /** Past-proposals lookback window (days). Spec default is 30. */
  pastProposalsWindowDays: number;
  /** Embedding model id used by dedupe.ts. */
  embeddingModel: string;
  /** Cosine-similarity threshold above which dedup drops a candidate. */
  dedupThreshold: number;
  /** Discord channel id used by approval-gate (T5). */
  discordChannelId?: string;
  /** When true, log decisions but never post to Discord. Used by smoke tests. */
  dryRun?: boolean;
  /**
   * Composite-score threshold above which a candidate auto-approves and is
   * enqueued via the control plane directly (skipping the Discord HITL click).
   * `composite_score >= threshold` → auto path; below → Discord HITL.
   *
   * Default is 1.0 = HITL-only (no behavioural change vs M5.2-T1). The cron
   * entry parses `IFLEET_PROPOSALS_AUTO_APPROVE_THRESHOLD` and threads the
   * value through here so tests can override per-run.
   */
  proposalsAutoApproveThreshold?: number;
}

/**
 * Persistence-side representation of a goal proposal — what T5 writes into
 * the `goal_proposals` table (one row per posted candidate). The column names
 * mirror the SQL schema in upgrades/06-goal-driven.md §"Data model".
 */
export interface GoalProposalRecord {
  id: string;
  repo_id: string;
  proposed_at: string;
  source: ProposalSource;
  title: string;
  rationale: string;
  estimated_value: number;
  estimated_difficulty: number;
  /** Vector embedding bytes — pgvector(1536). Optional in the TS view. */
  embedding?: number[] | null;
  decision: ProposalDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  resulting_task_id: string | null;
  resulting_pr_url: string | null;
  resulting_pr_outcome: ProposalPrOutcome | null;
}

/**
 * Result of one end-to-end Proposer run. Returned by `runProposer()` and
 * persisted alongside the row inserts so operators can answer "what did the
 * Proposer try last night?".
 */
export interface ProposerRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  repoId: string;
  /** Every candidate that survived budget (including ones dropped earlier are NOT here). */
  candidates: DedupedCandidate[];
  /** Count of Discord messages successfully posted. */
  posted: number;
  /** Optional human-readable failure reason when posted < candidates.length. */
  failureReason?: string;
}
