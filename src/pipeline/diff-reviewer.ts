import type {
  AttemptRecord,
  ReviewerVerdict,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { HAIKU_GATE_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT } from './prompts.js';

export interface RunReviewerInput {
  editorSpec: WorkerSpec;
  reviewerSpec: WorkerSpec;
  // Optional cheap pre-pass. When present, runs before the full reviewer and
  // short-circuits on CLEAN. Anything else (REVIEW_NEEDED, malformed, ok=false)
  // falls through to the full reviewer — the gate must never block a real
  // review, only skip one when it's clearly unnecessary.
  haikuGateSpec?: WorkerSpec;
  availableProviders?: ReadonlySet<string>;
  workerPool: WorkerPool;
  brief: string;
  plan: string;
  diff: string;
  abortSignal: AbortSignal;
}

export interface ReviewerOutput {
  attempt: AttemptRecord;
  verdict: ReviewerVerdict;
  // Which path the round took: 'haiku' = gate said CLEAN, full reviewer
  // skipped; 'full' = full reviewer ran (either because no gate was provided
  // or because the gate failed/escalated).
  gate: 'haiku' | 'full';
}

export class CrossProviderRuleViolation extends Error {
  constructor(editor: WorkerSpec, reviewer: WorkerSpec) {
    super(
      `Reviewer provider must be opposite of editor's. ` +
        `editor=${editor.provider} reviewer=${reviewer.provider}`,
    );
    this.name = 'CrossProviderRuleViolation';
  }
}

export function assertCrossProviderRule(
  editor: WorkerSpec,
  reviewer: WorkerSpec,
  availableProviders?: ReadonlySet<string>,
): void {
  if (editor.provider !== reviewer.provider) return;
  // Single-provider pool: cross-provider review is impossible. Warn and continue.
  if (availableProviders !== undefined && availableProviders.size <= 1) {
    console.warn(
      `[reviewer] cross-provider rule skipped: only provider "${editor.provider}" is registered. ` +
        `Enable a second worker provider for independent review.`,
    );
    return;
  }
  throw new CrossProviderRuleViolation(editor, reviewer);
}

export async function runReviewer(input: RunReviewerInput): Promise<ReviewerOutput> {
  assertCrossProviderRule(input.editorSpec, input.reviewerSpec, input.availableProviders);

  const brief = buildReviewerBrief(input.brief, input.plan, input.diff);

  // === Haiku cost-split gate (optional, additive) ===
  if (input.haikuGateSpec) {
    const gateResult = await runHaikuGate({
      gateSpec: input.haikuGateSpec,
      workerPool: input.workerPool,
      brief,
      abortSignal: input.abortSignal,
    });
    if (gateResult.kind === 'clean') {
      return {
        attempt: gateResult.attempt,
        verdict: { verdict: 'approve', concerns: [], raw: gateResult.attempt.output },
        gate: 'haiku',
      };
    }
    // 'escalate' or 'error' → fall through to full reviewer. The gate attempt
    // is intentionally discarded here: the runner's attempt log shows one
    // reviewer entry per round, and the full reviewer is the authoritative
    // verdict for this round.
  }

  // === Full reviewer ===
  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.reviewerSpec, brief, {
    role: 'reviewer',
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    abortSignal: input.abortSignal,
  });

  const result = await handle.result();
  const endedAt = Date.now();

  const verdict = parseVerdict(result.output);

  return {
    attempt: {
      role: 'reviewer',
      workerId: input.reviewerSpec.workerId,
      startedAt,
      endedAt,
      ok: result.ok,
      output: result.output,
      rateLimitHits: result.rateLimitHits,
      ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
      gate: 'full',
    },
    verdict,
    gate: 'full',
  };
}

function buildReviewerBrief(brief: string, plan: string, diff: string): string {
  return [
    '## Original brief',
    brief,
    '',
    '## Architect plan',
    plan,
    '',
    '## Diff to review',
    '```diff',
    diff,
    '```',
  ].join('\n');
}

type GateResult =
  | { kind: 'clean'; attempt: AttemptRecord }
  | { kind: 'escalate'; reason: string }
  | { kind: 'error'; reason: string };

export type GateDecision =
  | { kind: 'clean' }
  | { kind: 'escalate'; reason: string }
  | { kind: 'error'; reason: string };

interface RunHaikuGateInput {
  gateSpec: WorkerSpec;
  workerPool: WorkerPool;
  brief: string;
  abortSignal: AbortSignal;
}

async function runHaikuGate(input: RunHaikuGateInput): Promise<GateResult> {
  const startedAt = Date.now();
  let result;
  try {
    const handle = input.workerPool.spawn(input.gateSpec, input.brief, {
      role: 'reviewer',
      systemPrompt: HAIKU_GATE_SYSTEM_PROMPT,
      abortSignal: input.abortSignal,
    });
    result = await handle.result();
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  const endedAt = Date.now();
  if (!result.ok) {
    return { kind: 'error', reason: result.error ?? 'gate worker failed' };
  }
  const decision = parseGateOutput(result.output);
  if (decision.kind !== 'clean') return decision;
  const attempt: AttemptRecord = {
    role: 'reviewer',
    workerId: input.gateSpec.workerId,
    startedAt,
    endedAt,
    ok: true,
    output: result.output,
    rateLimitHits: result.rateLimitHits,
    ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
    gate: 'haiku',
  };
  return { kind: 'clean', attempt };
}

// Exported for tests. Tolerant to leading/trailing whitespace and the model
// occasionally wrapping its answer in quotes or a code fence.
export function parseGateOutput(raw: string): GateDecision {
  const text = stripFences(raw).trim();
  if (text.length === 0) {
    return { kind: 'error', reason: 'gate returned empty output' };
  }
  const firstLine = (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim();
  const cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  const upper = cleaned.toUpperCase();
  if (upper === 'CLEAN' || upper.startsWith('CLEAN:') || upper.startsWith('CLEAN ')) {
    return { kind: 'clean' };
  }
  if (upper.startsWith('REVIEW_NEEDED')) {
    const colonIdx = cleaned.indexOf(':');
    const reason = colonIdx >= 0 ? cleaned.slice(colonIdx + 1).trim() : '';
    return { kind: 'escalate', reason: reason || 'gate flagged REVIEW_NEEDED' };
  }
  return { kind: 'escalate', reason: `gate output unrecognized: ${truncate(cleaned, 200)}` };
}

function stripFences(text: string): string {
  return text.replace(/^```[a-zA-Z0-9]*\s*/g, '').replace(/```\s*$/g, '');
}

export function parseVerdict(raw: string): ReviewerVerdict {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return {
      verdict: 'request_changes',
      concerns: [`Reviewer returned no parseable JSON. Raw output: ${truncate(raw, 400)}`],
      raw,
    };
  }
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!isPlainObject(parsed)) throw new Error('not an object');
    const verdict = parsed.verdict;
    const concernsField = parsed.concerns;
    if (verdict !== 'approve' && verdict !== 'request_changes') {
      throw new Error(`invalid verdict: ${String(verdict)}`);
    }
    if (!Array.isArray(concernsField) || !concernsField.every((c) => typeof c === 'string')) {
      throw new Error('concerns must be string[]');
    }
    return { verdict, concerns: concernsField, raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'request_changes',
      concerns: [`Reviewer JSON malformed: ${message}. Raw: ${truncate(raw, 400)}`],
      raw,
    };
  }
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
