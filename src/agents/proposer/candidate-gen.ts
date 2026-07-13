// M5 Proposer — candidate generation (Lane T4).
//
// `generateCandidates` asks Haiku for 5-20 candidate goals given the loaded
// `ProposerContext`. The output JSON is parsed defensively — Haiku occasionally
// emits a prose preamble or wraps its array in a code fence, so we extract
// the first balanced `[...]` block and tolerate junk around it.
//
// Cost shape (canonical-pattern §3): Haiku tier per spec — a single one-shot
// completion per nightly run. The editor-must-be-Sonnet-floor rule does NOT
// apply: candidate-gen *generates ideas*, it does not edit code.

import type {
  Candidate,
  ProposalSource,
  ProposerConfig,
  ProposerContext,
} from './types.js';

const HAIKU_MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const VALID_SOURCES: ReadonlySet<ProposalSource> = new Set([
  'sprint_gap',
  'learnings',
  'drift',
  'error_log',
  'coherence',
]);

const SYSTEM_PROMPT = [
  'You are the Proposer for an autonomous software fleet. Each night you read',
  'the repo\'s SPRINT.md / ROADMAP.md / NON_GOALS.md plus recent learnings,',
  'doctor fingerprints, PR decisions, and past proposals, and you propose 5-20',
  'concrete tasks aligned with the sprint goal.',
  '',
  'Constraints:',
  '- Each candidate MUST advance the sprint goal in SPRINT.md.',
  '- NEVER propose anything listed in NON_GOALS.md.',
  '- NEVER propose anything whose title appears in pastProposals.',
  '- Each candidate must fit a single PR (one task, bounded scope).',
  '- Prefer fixes for recurring doctor fingerprints over new features.',
  '',
  'Output: a JSON array (and ONLY a JSON array, no prose, no markdown fence)',
  'of 5-20 objects with shape:',
  '  { "title": string, "rationale": string,',
  '    "estimated_value": number /* 0..1 */,',
  '    "estimated_difficulty": number /* 0..1 */,',
  '    "source": "sprint_gap" | "learnings" | "drift" | "error_log" | "coherence" }',
].join('\n');

export interface LlmCompleter {
  /** Run one non-streaming chat turn and return assistant text. */
  complete(opts: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
    maxTokens: number;
  }): Promise<string>;
}

export interface GenerateCandidatesDeps {
  /** Override the Haiku-call client. Tests inject a stub. */
  llm?: LlmCompleter;
  /** Logging sink; default = console.warn. */
  warn?: (line: string) => void;
}

export class AnthropicCompleter implements LlmCompleter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Proposer candidate-gen needs Haiku access ' +
          '— either export ANTHROPIC_API_KEY or inject an LlmCompleter via deps.llm.',
      );
    }
    this.apiKey = key;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(opts: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
    maxTokens: number;
  }): Promise<string> {
    const resp = await this.fetchImpl(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.systemPrompt,
        messages: [{ role: 'user', content: opts.userPrompt }],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 400)}`);
    }
    const body = (await resp.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const parts = body.content ?? [];
    return parts
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  }
}

export async function generateCandidates(
  ctx: ProposerContext,
  // _cfg is intentionally unused here — retained for interface compatibility with the
  // stage type in index.ts (`stages.generateCandidates`) and for potential future use
  // (e.g., overriding the Haiku model or max_tokens via config). (AUDIT-IFleet-4abde52c)
  _cfg: ProposerConfig,
  deps: GenerateCandidatesDeps = {},
): Promise<Candidate[]> {
  const warn = deps.warn ?? defaultWarn;
  const llm = deps.llm ?? new AnthropicCompleter();

  const userPrompt = buildUserPrompt(ctx);

  let raw: string;
  try {
    raw = await llm.complete({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      model: HAIKU_MODEL_DEFAULT,
      maxTokens: 4096,
    });
  } catch (err) {
    warn(`proposer/candidate-gen: Haiku call failed (${reason(err)}) — returning no candidates`);
    return [];
  }

  const parsed = parseCandidatesArray(raw);
  if (parsed.length === 0) {
    warn('proposer/candidate-gen: Haiku response had no parseable candidate array');
  }

  const seenTitles = new Set(
    [
      ...ctx.pastProposals.map((p) => p.title.trim().toLowerCase()),
    ].filter((s) => s.length > 0),
  );
  const nonGoals = extractNonGoalLines(ctx.nonGoalsMd);

  const cleaned: Candidate[] = [];
  for (const item of parsed) {
    const candidate = normalizeCandidate(item);
    if (!candidate) continue;
    const titleKey = candidate.title.trim().toLowerCase();
    if (titleKey.length === 0) continue;
    if (seenTitles.has(titleKey)) continue;
    if (nonGoals.some((ng) => titleKey.includes(ng))) continue;
    seenTitles.add(titleKey);
    cleaned.push(candidate);
  }

  // Hard guard against runaway responses — spec caps at 20.
  return cleaned.slice(0, 20);
}

function buildUserPrompt(ctx: ProposerContext): string {
  const parts: string[] = [];
  parts.push(`Repo: ${ctx.repoId}`);
  parts.push(`Loaded at: ${ctx.loadedAt}`);
  parts.push('');
  parts.push('## SPRINT.md');
  parts.push(truncate(ctx.sprintMd || '(empty)', 4000));
  parts.push('');
  parts.push('## ROADMAP.md');
  parts.push(truncate(ctx.roadmapMd || '(empty)', 4000));
  parts.push('');
  parts.push('## NON_GOALS.md');
  parts.push(truncate(ctx.nonGoalsMd || '(empty)', 2000));
  parts.push('');
  parts.push('## Recent learnings (tail)');
  parts.push(ctx.learnings.slice(-30).join('\n') || '(none)');
  parts.push('');
  parts.push('## Doctor fingerprints (window)');
  if (ctx.recentDoctorFingerprints.length === 0) {
    parts.push('(none)');
  } else {
    for (const fp of ctx.recentDoctorFingerprints.slice(0, 30)) {
      parts.push(`- ${fp.tag} (count=${fp.count}, first_seen=${fp.first_seen})`);
    }
  }
  parts.push('');
  parts.push('## PR decisions (30d)');
  if (ctx.recentPrDecisions.length === 0) {
    parts.push('(none)');
  } else {
    for (const pr of ctx.recentPrDecisions.slice(0, 30)) {
      parts.push(`- PR #${pr.prNumber} ${pr.verdict} (task=${pr.taskId})`);
    }
  }
  parts.push('');
  parts.push('## Past proposals (30d) — DO NOT REPEAT');
  const cappedProposals = ctx.pastProposals.slice(0, 30);
  const mergedProps = cappedProposals.filter((pp) => pp.resultingPrOutcome === 'merged');
  const closedUnmergedProps = cappedProposals.filter((pp) => pp.resultingPrOutcome === 'closed_unmerged');
  const rejectedHitlProps = cappedProposals.filter(
    (pp) =>
      pp.resultingPrOutcome !== 'merged' &&
      pp.resultingPrOutcome !== 'closed_unmerged' &&
      pp.decision === 'rejected',
  );
  const inFlightProps = cappedProposals.filter(
    (pp) =>
      pp.resultingPrOutcome !== 'merged' &&
      pp.resultingPrOutcome !== 'closed_unmerged' &&
      pp.decision !== 'rejected',
  );

  parts.push(
    '### MERGED — These shipped to main — lean toward similar patterns when you propose.',
  );
  if (mergedProps.length === 0) {
    parts.push('(none)');
  } else {
    for (const pp of mergedProps) {
      parts.push(`- "${pp.title}"`);
    }
  }
  parts.push(
    '### CLOSED_UNMERGED — These were attempted but rejected at review — treat similar titles as ANTI-SIGNAL, not just dedupe. Do not re-propose.',
  );
  if (closedUnmergedProps.length === 0) {
    parts.push('(none)');
  } else {
    for (const pp of closedUnmergedProps) {
      parts.push(`- "${pp.title}"`);
    }
  }
  parts.push(
    '### REJECTED_AT_HITL — Human reviewer rejected these before a PR existed. Do not re-propose.',
  );
  if (rejectedHitlProps.length === 0) {
    parts.push('(none)');
  } else {
    for (const pp of rejectedHitlProps) {
      parts.push(`- "${pp.title}"`);
    }
  }
  parts.push("### IN_FLIGHT — Dedupe against these — they're already in flight.");
  if (inFlightProps.length === 0) {
    parts.push('(none)');
  } else {
    for (const pp of inFlightProps) {
      parts.push(`- "${pp.title}"`);
    }
  }
  parts.push('');
  parts.push('Now output the JSON array.');
  return parts.join('\n');
}

function extractNonGoalLines(md: string): string[] {
  return md
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*\s]+/, '').trim().toLowerCase())
    .filter((l) => l.length >= 4);
}

function normalizeCandidate(raw: unknown): Candidate | null {
  if (!isPlainObject(raw)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : null;
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : null;
  if (!title || !rationale) return null;
  const value = clamp01(toFiniteNumber(raw.estimated_value));
  const difficulty = clamp01(toFiniteNumber(raw.estimated_difficulty));
  const source = normalizeSource(raw.source);
  return {
    title,
    rationale,
    estimated_value: value,
    estimated_difficulty: difficulty,
    source,
  };
}

function normalizeSource(value: unknown): ProposalSource {
  if (typeof value === 'string' && VALID_SOURCES.has(value as ProposalSource)) {
    return value as ProposalSource;
  }
  return 'sprint_gap';
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0.5;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Exported for tests — pulls the first balanced JSON array out of a free-form
// model response. Tolerates leading prose, trailing prose, and markdown fences.
export function parseCandidatesArray(raw: string): unknown[] {
  const text = stripFences(raw);
  const start = text.indexOf('[');
  if (start === -1) return [];
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9]*\s*/g, '').replace(/```\s*$/g, '');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWarn(line: string): void {
   
  console.warn(line);
}
