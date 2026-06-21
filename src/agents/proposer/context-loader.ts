// M5 Proposer — context loader.
//
// Builds a `ProposerContext` from every signal candidate-gen needs:
//   1. SPRINT.md / ROADMAP.md / NON_GOALS.md from the repo root
//   2. Recent tail of `.omc/learnings.md` (via src/pipeline/learnings.ts)
//   3. Last `cfg.windowDays` of doctor fingerprints
//   4. Last 30d of pr_decisions for this repo
//   5. Last 30d of goal_proposals (T5's table — fail-open if not yet landed)
//
// Every source is loaded fail-open: a missing file, a thrown read, or a
// not-yet-landed table produces an empty default — never a throw. This keeps
// the nightly run from crashing on a fresh repo / partial deploy.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readRecentLearnings, LEARNINGS_RELATIVE_PATH } from '../../pipeline/learnings.js';
import { loadFingerprints, type Fingerprint } from '../../pipeline/fingerprints.js';
import type {
  DoctorFingerprintSummary,
  PastProposalSummary,
  PrDecisionSummary,
  ProposerConfig,
  ProposerContext,
} from './types.js';

/** Where loadFingerprints looks; canonical doctor location. */
const FINGERPRINTS_RELATIVE_PATH = '.omc/fingerprints.json';

/** 30d window for pr_decisions / past proposals — matches spec §"Pipeline step". */
const PAST_PROPOSALS_DEFAULT_DAYS = 30;

/** Default learnings tail size. */
const LEARNINGS_TAIL_DEFAULT = 50;

/**
 * Read-side dependencies the loader needs that aren't satisfied by direct
 * filesystem reads. Both are optional — when omitted, the corresponding source
 * yields an empty array (fail-open).
 *
 * Splitting these out lets the orchestrator inject the live `TaskStore` /
 * `GoalProposalsStore` in production while tests can pass `{}` to exercise
 * the all-empty path.
 */
export interface ContextLoaderDeps {
  /**
   * Returns PR decisions for `repoId` newest-first. Production wires this to
   * `TaskStore.getPrDecisionsByRepo` (src/queue/store.ts). Omitted → empty.
   */
  prDecisionsByRepo?: (
    repoId: string,
    limit: number,
  ) => Promise<PrDecisionSummary[]> | PrDecisionSummary[];
  /**
   * Returns goal_proposals for `repoId` newest-first. Production wires this
   * to T5's read API once the migration lands. Today this is the fail-open
   * seam — T5's PR registers the live implementation here.
   */
  pastProposalsByRepo?: (
    repoId: string,
    limit: number,
  ) => Promise<PastProposalSummary[]> | PastProposalSummary[];
  /**
   * Optional warn-line sink — receives one string per source that fell back
   * to its empty default. Tests can capture this to assert fail-open behaviour
   * without coupling to console.warn.
   */
  warn?: (line: string) => void;
}

/**
 * Build the full `ProposerContext` for one nightly Proposer run.
 *
 * Contract: NEVER throws. Any per-source failure falls back to an empty
 * default and emits one warn line through `deps.warn`. Callers must be able
 * to feed the returned context straight into candidate-gen.
 */
export async function loadProposerContext(
  repoId: string,
  cfg: ProposerConfig,
  deps: ContextLoaderDeps = {},
): Promise<ProposerContext> {
  const warn = deps.warn ?? defaultWarn;

  const [sprintMd, roadmapMd, nonGoalsMd] = await Promise.all([
    safeReadFile(join(cfg.repoRoot, 'SPRINT.md'), 'SPRINT.md', warn),
    safeReadFile(join(cfg.repoRoot, 'ROADMAP.md'), 'ROADMAP.md', warn),
    safeReadFile(join(cfg.repoRoot, 'NON_GOALS.md'), 'NON_GOALS.md', warn),
  ]);

  const learnings = await safeReadLearnings(cfg.repoRoot, warn);
  const recentDoctorFingerprints = safeReadFingerprints(cfg.repoRoot, cfg.windowDays, warn);

  const recentPrDecisions = await safePrDecisions(repoId, deps, warn);
  const pastProposals = await safePastProposals(repoId, deps, warn);

  return {
    repoId,
    repoRoot: cfg.repoRoot,
    sprintMd,
    roadmapMd,
    nonGoalsMd,
    learnings,
    recentDoctorFingerprints,
    recentPrDecisions,
    pastProposals,
    loadedAt: new Date().toISOString(),
  };
}

async function safeReadFile(
  path: string,
  label: string,
  warn: (line: string) => void,
): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    warn(`proposer/context-loader: ${label} not readable (${reason(err)}) — using empty default`);
    return '';
  }
}

async function safeReadLearnings(
  repoRoot: string,
  warn: (line: string) => void,
): Promise<string[]> {
  if (!existsSync(join(repoRoot, LEARNINGS_RELATIVE_PATH))) {
    warn('proposer/context-loader: learnings.md not found — using empty default');
    return [];
  }
  try {
    return await readRecentLearnings(repoRoot, LEARNINGS_TAIL_DEFAULT);
  } catch (err) {
    warn(`proposer/context-loader: learnings unavailable (${reason(err)}) — using empty default`);
    return [];
  }
}

function safeReadFingerprints(
  repoRoot: string,
  windowDays: number,
  warn: (line: string) => void,
): DoctorFingerprintSummary[] {
  const path = join(repoRoot, FINGERPRINTS_RELATIVE_PATH);
  if (!existsSync(path)) {
    warn('proposer/context-loader: fingerprints.json not found — using empty default');
    return [];
  }
  let store: Record<string, Fingerprint>;
  try {
    store = loadFingerprints(path);
  } catch (err) {
    warn(
      `proposer/context-loader: fingerprints unavailable (${reason(err)}) — using empty default`,
    );
    return [];
  }
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const out: DoctorFingerprintSummary[] = [];
  for (const [hash, fp] of Object.entries(store)) {
    const seenMs = Date.parse(fp.first_seen);
    if (Number.isNaN(seenMs) || seenMs < cutoff) continue;
    out.push({
      hash,
      tag: fp.tag,
      count: fp.count,
      first_seen: fp.first_seen,
      ...(fp.last_fix_commit !== undefined ? { last_fix_commit: fp.last_fix_commit } : {}),
    });
  }
  // Most-frequent first — candidate-gen weights repeated failures heavier.
  out.sort((a, b) => b.count - a.count);
  return out;
}

async function safePrDecisions(
  repoId: string,
  deps: ContextLoaderDeps,
  warn: (line: string) => void,
): Promise<PrDecisionSummary[]> {
  if (!deps.prDecisionsByRepo) {
    warn('proposer/context-loader: pr_decisions reader not wired — using empty default');
    return [];
  }
  try {
    const all = await deps.prDecisionsByRepo(repoId, 500);
    const cutoff = Date.now() - PAST_PROPOSALS_DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    return all.filter((d) => d.createdAt >= cutoff);
  } catch (err) {
    warn(
      `proposer/context-loader: pr_decisions read failed (${reason(err)}) — using empty default`,
    );
    return [];
  }
}

async function safePastProposals(
  repoId: string,
  deps: ContextLoaderDeps,
  warn: (line: string) => void,
): Promise<PastProposalSummary[]> {
  if (!deps.pastProposalsByRepo) {
    // T5's migration may not have landed yet — this is the documented fail-open path.
    warn(
      'proposer/context-loader: goal_proposals reader not wired (T5 not landed?) — using empty default',
    );
    return [];
  }
  try {
    const all = await deps.pastProposalsByRepo(repoId, 500);
    const cutoff = Date.now() - PAST_PROPOSALS_DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    return all.filter((p) => p.proposedAt >= cutoff);
  } catch (err) {
    warn(
      `proposer/context-loader: goal_proposals read failed (${reason(err)}) — using empty default`,
    );
    return [];
  }
}

function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultWarn(line: string): void {
  console.warn(line);
}
