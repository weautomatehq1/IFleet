import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AttemptRecord, WorkerPool, WorkerSpec } from './types.js';
import { PLAN_REVIEWER_SYSTEM_PROMPT } from './prompts.js';

// Defensive fallbacks used when config/routing.json is missing or omits the
// pipeline.planReviewer fields. Spec source of truth is
// docs/elevation/upgrades/02-plan-reviewer.md ("Max 2 veto cycles" /
// "Cap plan-review cost at 10% of architect cost"); config/routing.json
// mirrors those values and is the single source of truth at runtime.
const PLAN_REVIEWER_MAX_VETOES_FALLBACK = 2;
const PLAN_REVIEW_COST_CAP_MULTIPLIER_FALLBACK = 0.1;

export function loadPlanReviewerDefaults(routingJsonPath?: string): {
  maxVetoes: number;
  costCapMultiplier: number;
} {
  try {
    const defaultPath = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'config', 'routing.json');
    const raw = readFileSync(routingJsonPath ?? defaultPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      pipeline?: {
        planReviewer?: {
          maxVetoes?: number;
          costCapPctOfArchitect?: number;
        };
      };
    };
    const pr = parsed.pipeline?.planReviewer;
    const maxVetoes =
      typeof pr?.maxVetoes === 'number' && Number.isFinite(pr.maxVetoes) && pr.maxVetoes > 0
        ? Math.floor(pr.maxVetoes)
        : PLAN_REVIEWER_MAX_VETOES_FALLBACK;
    // routing.json carries percent (e.g. 10), the runtime uses multiplier
    // (e.g. 0.1). Convert at the boundary so the JSON stays human-readable.
    // 0 falls back to the default (0.1) because a 0% cap silently disables
    // plan review entirely; if you actually want to disable plan review,
    // remove the planReviewer block from routing.json.
    const costCapMultiplier =
      typeof pr?.costCapPctOfArchitect === 'number' &&
      Number.isFinite(pr.costCapPctOfArchitect) &&
      pr.costCapPctOfArchitect > 0
        ? pr.costCapPctOfArchitect / 100
        : PLAN_REVIEW_COST_CAP_MULTIPLIER_FALLBACK;
    return { maxVetoes, costCapMultiplier };
  } catch {
    return {
      maxVetoes: PLAN_REVIEWER_MAX_VETOES_FALLBACK,
      costCapMultiplier: PLAN_REVIEW_COST_CAP_MULTIPLIER_FALLBACK,
    };
  }
}

const PLAN_REVIEWER_DEFAULTS = loadPlanReviewerDefaults();

/**
 * Maximum number of veto cycles before the runner escalates to a human.
 * After this many consecutive vetoes the sprint halts and Sebastian is
 * pinged with the structured disagreement (see runner.ts).
 *
 * Sourced from `config/routing.json` → `pipeline.planReviewer.maxVetoes`,
 * with a defensive fallback when the field is missing.
 */
export const PLAN_REVIEWER_MAX_VETOES = PLAN_REVIEWER_DEFAULTS.maxVetoes;

export type PlanReviewReasonKind =
  | 'invariant'
  | 'failure-mode'
  | 'scope'
  | 'feasibility';

export interface PlanReviewVetoReason {
  kind: PlanReviewReasonKind;
  message: string;
  suggested_revision: string;
}

/**
 * Structured output of the plan-reviewer role. Persisted to the shared
 * trace as the `payload` of a `plan-reviewer.completed` event (see
 * ADR-0001 — single shared trace).
 */
export type PlanReview =
  | { decision: 'approve'; rationale: string }
  | { decision: 'veto'; reasons: PlanReviewVetoReason[] };

export interface RunPlanReviewerInput {
  /**
   * The architect's plan text. Reviewed verbatim — no truncation.
   */
  plan: string;
  /**
   * The original brief. Reviewed alongside the plan so the reviewer can
   * check the plan addresses the brief (and only the brief — scope check).
   */
  brief: string;
  /**
   * Veto cycle number (1-indexed). Round 1 is the first review of a fresh
   * plan; round 2 is the second after the architect revised in response to
   * a round-1 veto. The runner caps at {@link PLAN_REVIEWER_MAX_VETOES}.
   */
  attempt: number;
  /**
   * Architect spec — used to enforce the "reviewer not weaker than
   * architect" routing floor. The pool selector is expected to have already
   * applied the floor; this is kept for symmetry with the diff-reviewer
   * and for future audit logging.
   */
  architectSpec: WorkerSpec;
  /**
   * Plan-reviewer worker. Default is Haiku (cheap, high-volume) but the
   * routing config can upgrade per-repo.
   */
  reviewerSpec: WorkerSpec;
  workerPool: WorkerPool;
  abortSignal: AbortSignal;
  /**
   * Absolute path to the host repo root. When set, the reviewer reads any
   * invariants under `<repoRoot>/.ifleet/invariants/<orgRepo>/` and appends
   * them to its input as a "Listed invariants" section so it can cite ids.
   * Absent → invariants section is omitted (still works; no veto on
   * invariants will fire).
   */
  repoRoot?: string;
  /**
   * Repo identifier in `org_repo` form (matches the invariants dir name).
   * Required for invariants lookup; absent → invariants are skipped.
   */
  repoSlug?: string;
  /**
   * Previously surfaced veto reasons, concatenated so the reviewer can
   * notice if the architect's revised plan addresses them. Empty on
   * attempt 1.
   */
  priorReasons?: PlanReviewVetoReason[];
  /**
   * Absolute path to the per-task git worktree. The plan-reviewer is
   * read-only by intent, but we still sandbox it so an out-of-scope tool
   * call (Bash, Write) can't touch the host repo.
   */
  worktreePath?: string;
  /**
   * Cost ceiling for plan review, expressed as a multiplier of the
   * architect's cost. The spec ("Cap plan-review cost at 10% of architect
   * cost") defaults this to 0.10. When the worker reports
   * `totalCostUsd > architectCostUsd * costCapMultiplier`, the result is
   * marked as cost-capped.
   */
  costCapMultiplier?: number;
  /**
   * The architect attempt's reported cost. When undefined the cost cap is
   * not enforced (no reference to compare against).
   */
  architectCostUsd?: number;
}

export type PlanReviewSkipReason = 'rate-limit' | 'cost-cap' | 'worker-error';

export interface PlanReviewerOutput {
  attempt: AttemptRecord;
  /**
   * Parsed review. When the worker is skipped or fails, the runner treats
   * the plan as implicitly approved and surfaces `skipped` (per spec —
   * "Plan-reviewer model unavailable (rate limit) → skip review, log
   * plan_review: skipped").
   */
  review: PlanReview;
  /**
   * Indicates the review was skipped rather than computed. Empty when the
   * review is authoritative.
   */
  skipped?: PlanReviewSkipReason;
}

/**
 * Plan-review cost ceiling expressed as a multiplier of the architect's cost.
 * Sourced from `config/routing.json` → `pipeline.planReviewer.costCapPctOfArchitect`
 * (percent, e.g. `10`); converted to a multiplier (`0.1`) at the boundary.
 */
export const DEFAULT_PLAN_REVIEW_COST_CAP_MULTIPLIER = PLAN_REVIEWER_DEFAULTS.costCapMultiplier;

export async function runPlanReviewer(
  input: RunPlanReviewerInput,
): Promise<PlanReviewerOutput> {
  const startedAt = Date.now();

  // Build the review brief. Invariants are best-effort — a missing dir is
  // treated as "no invariants to check" (the runner still works, the
  // reviewer simply can't fire `kind: 'invariant'` vetoes).
  const invariantSection = await readInvariantsSection(
    input.repoRoot,
    input.repoSlug,
  );
  const priorSection = formatPriorReasons(input.priorReasons);
  const reviewerBrief = buildPlanReviewerBrief({
    brief: input.brief,
    plan: input.plan,
    attempt: input.attempt,
    invariants: invariantSection,
    prior: priorSection,
  });

  let result;
  try {
    const handle = input.workerPool.spawn(input.reviewerSpec, reviewerBrief, {
      role: 'reviewer',
      systemPrompt: PLAN_REVIEWER_SYSTEM_PROMPT,
      abortSignal: input.abortSignal,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    result = await handle.result();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return skipped({
      reason: 'worker-error',
      message,
      reviewerSpec: input.reviewerSpec,
      startedAt,
    });
  }
  const endedAt = Date.now();

  if (!result.ok) {
    return skipped({
      reason: 'worker-error',
      message: result.error ?? 'plan-reviewer worker failed',
      reviewerSpec: input.reviewerSpec,
      startedAt,
      endedAt,
      rateLimitHits: result.rateLimitHits,
    });
  }

  // Spec: "Plan-reviewer model unavailable (rate limit) → skip review,
  // log plan_review: skipped". We treat any rate-limit hits as "skipped"
  // when the worker still managed to return output — the output may be a
  // partial / cached response, which we don't trust to gate the editor.
  if (result.rateLimitHits > 0) {
    return skipped({
      reason: 'rate-limit',
      message: `plan-reviewer hit rate limit ${result.rateLimitHits}x — skipping`,
      reviewerSpec: input.reviewerSpec,
      startedAt,
      endedAt,
      rateLimitHits: result.rateLimitHits,
      ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
      output: result.output,
    });
  }

  // Spec: "Cap plan-review cost at 10% of architect cost; abort if exceeded".
  // "Abort" here means: do not block the editor on this review. The architect's
  // plan proceeds and ops gets a structured event from the runner.
  const cap = input.costCapMultiplier ?? DEFAULT_PLAN_REVIEW_COST_CAP_MULTIPLIER;
  if (
    input.architectCostUsd !== undefined &&
    result.totalCostUsd !== undefined &&
    result.totalCostUsd > input.architectCostUsd * cap
  ) {
    return skipped({
      reason: 'cost-cap',
      message:
        `plan-reviewer cost ${result.totalCostUsd.toFixed(4)} exceeded ` +
        `${(cap * 100).toFixed(0)}% of architect cost ${input.architectCostUsd.toFixed(4)} — skipping`,
      reviewerSpec: input.reviewerSpec,
      startedAt,
      endedAt,
      rateLimitHits: result.rateLimitHits,
      totalCostUsd: result.totalCostUsd,
      output: result.output,
    });
  }

  const review = parsePlanReview(result.output);

  const attempt: AttemptRecord = {
    role: 'reviewer',
    workerId: input.reviewerSpec.workerId,
    startedAt,
    endedAt,
    ok: true,
    output: result.output,
    rateLimitHits: result.rateLimitHits,
    ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
  };

  return { attempt, review };
}

interface SkippedArgs {
  reason: PlanReviewSkipReason;
  message: string;
  reviewerSpec: WorkerSpec;
  startedAt: number;
  endedAt?: number;
  rateLimitHits?: number;
  totalCostUsd?: number;
  output?: string;
}

function skipped(args: SkippedArgs): PlanReviewerOutput {
  const endedAt = args.endedAt ?? Date.now();
  const attempt: AttemptRecord = {
    role: 'reviewer',
    workerId: args.reviewerSpec.workerId,
    startedAt: args.startedAt,
    endedAt,
    ok: false,
    output: args.output ?? args.message,
    rateLimitHits: args.rateLimitHits ?? 0,
    ...(args.totalCostUsd !== undefined && { totalCostUsd: args.totalCostUsd }),
  };
  // When skipped, the runner treats the plan as implicitly approved — see
  // ADR-0001 ("never let a sidecar block the trace"). The structured review
  // payload makes that explicit instead of returning an out-of-band signal.
  const review: PlanReview = {
    decision: 'approve',
    rationale: `skipped (${args.reason}): ${args.message}`,
  };
  return { attempt, review, skipped: args.reason };
}

interface BuildPlanReviewerBriefInput {
  brief: string;
  plan: string;
  attempt: number;
  invariants: string;
  prior: string;
}

function buildPlanReviewerBrief(input: BuildPlanReviewerBriefInput): string {
  const parts = [
    `## Plan review — attempt ${input.attempt}/${PLAN_REVIEWER_MAX_VETOES}`,
    '',
    '## Original brief',
    input.brief,
    '',
    '## Architect plan',
    input.plan,
  ];
  if (input.invariants.length > 0) {
    parts.push('', input.invariants);
  }
  if (input.prior.length > 0) {
    parts.push('', input.prior);
  }
  return parts.join('\n');
}

function formatPriorReasons(prior?: PlanReviewVetoReason[]): string {
  if (!prior || prior.length === 0) return '';
  const lines = [
    '## Prior veto reasons (architect was asked to address these)',
    'If the revised plan still does not address a reason, veto it again with the same kind.',
    'If you would issue the same reason twice on the same hallucinated grounds, the runner will escalate.',
  ];
  for (const [i, r] of prior.entries()) {
    lines.push(
      `${i + 1}. [${r.kind}] ${r.message}`,
      `   suggested: ${r.suggested_revision}`,
    );
  }
  return lines.join('\n');
}

async function readInvariantsSection(
  repoRoot?: string,
  repoSlug?: string,
): Promise<string> {
  if (!repoRoot || !repoSlug) return '';
  const dir = join(repoRoot, '.ifleet', 'invariants', repoSlug);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return '';
  }
  const wanted = entries.filter(
    (e) => e.endsWith('.yml') || e.endsWith('.md') || e.endsWith('.ts'),
  );
  if (wanted.length === 0) return '';
  const lines: string[] = ['## Listed invariants for this repo'];
  for (const file of wanted.sort()) {
    let body = '';
    try {
      body = await readFile(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    lines.push('', `### ${file}`, '```', body.trim(), '```');
  }
  return lines.join('\n');
}

/**
 * Parse the plan-reviewer's JSON output into a structured {@link PlanReview}.
 * Tolerant of leading/trailing prose and markdown code fences. On any
 * malformed input, returns a synthetic veto with a `feasibility` reason so
 * the runner records the failure in the trace rather than silently passing.
 */
export function parsePlanReview(raw: string): PlanReview {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return malformedVeto(`no parseable JSON in output: ${truncate(raw, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return malformedVeto(`JSON.parse failed: ${message}`);
  }
  if (!isPlainObject(parsed)) {
    return malformedVeto('output is not a JSON object');
  }
  const decision = parsed.decision;
  if (decision === 'approve') {
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
    return { decision: 'approve', rationale };
  }
  if (decision === 'veto') {
    const reasonsField = parsed.reasons;
    if (!Array.isArray(reasonsField) || reasonsField.length === 0) {
      return malformedVeto('veto without reasons[]');
    }
    const reasons: PlanReviewVetoReason[] = [];
    for (const r of reasonsField) {
      if (!isPlainObject(r)) continue;
      const kind = r.kind;
      const message = r.message;
      const revision = r.suggested_revision;
      if (
        (kind === 'invariant' ||
          kind === 'failure-mode' ||
          kind === 'scope' ||
          kind === 'feasibility') &&
        typeof message === 'string' &&
        typeof revision === 'string'
      ) {
        reasons.push({ kind, message, suggested_revision: revision });
      }
    }
    if (reasons.length === 0) {
      return malformedVeto('veto reasons[] had no well-formed entries');
    }
    return { decision: 'veto', reasons };
  }
  return malformedVeto(`unknown decision: ${String(decision)}`);
}

function malformedVeto(detail: string): PlanReview {
  // Surface as a feasibility veto so the existing escalation path picks it
  // up — but with a self-describing message so ops can tell the parse
  // failed rather than a real plan defect.
  return {
    decision: 'veto',
    reasons: [
      {
        kind: 'feasibility',
        message: `plan-reviewer output malformed: ${detail}`,
        suggested_revision:
          'Retry the plan-reviewer once; if it fails again, escalate to a human.',
      },
    ],
  };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Helper used by the runner to render a structured disagreement for human
 * escalation after {@link PLAN_REVIEWER_MAX_VETOES} consecutive vetoes.
 * Format follows the escalation message style added in PR #119.
 */
export function formatPlanReviewerEscalation(
  taskId: string,
  reasons: PlanReviewVetoReason[],
): string {
  const lines = [
    `🛑 Plan-Reviewer vetoed plan ${PLAN_REVIEWER_MAX_VETOES}× in a row — escalating`,
    `Task: ${taskId}`,
    '',
    'Reasons from the final attempt:',
  ];
  for (const r of reasons) {
    lines.push(
      `• ${r.kind}: ${r.message}`,
      `  Suggested: ${r.suggested_revision}`,
    );
  }
  lines.push('', '@Sebastian — needs a human call. Reply `approve` to override or `reject` to cancel.');
  return lines.join('\n');
}
