import type {
  AttemptRecord,
  ReviewerVerdict,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts.js';

export interface RunReviewerInput {
  editorSpec: WorkerSpec;
  reviewerSpec: WorkerSpec;
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

  const brief = [
    '## Original brief',
    input.brief,
    '',
    '## Architect plan',
    input.plan,
    '',
    '## Diff to review',
    '```diff',
    input.diff,
    '```',
  ].join('\n');

  const startedAt = Date.now();

  // Fresh session — do not pass resumeSessionId; the worker pool issues a new one.
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
    },
    verdict,
  };
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
