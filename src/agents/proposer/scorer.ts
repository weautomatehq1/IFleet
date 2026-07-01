// M5 Proposer — scoring (Lane T4).
//
// `scoreCandidates` attaches `sprint_alignment` (cosine between candidate
// embedding and SPRINT.md embedding) and `composite_score` (weighted sum of
// value / inverse-difficulty / alignment) to every candidate, then drops the
// bottom 80% of NOT-already-dropped entries by composite_score. Force-explore
// entries promoted by dedupe are protected from the bottom-80% cull so the
// bandit signal survives into the budget gate.
//
// Embeddings: scorer reuses `__embedding` set on each candidate by dedupe.ts
// when present. SPRINT.md is embedded once per run. If the embedding provider
// is unavailable, alignment falls back to 0 and we still emit a usable score.
//
// Telemetry: emits one `[PROPOSER-TELEMETRY] {...}` line on stderr per ADR-0004
// §3.6 (cost-tuning signal). No closure-log path exists in IFleet yet — T5's
// `resulting_pr_outcome` is the long-term closure point; until then we emit
// to stderr with a stable JSON shape callers can grep.

import { createEmbeddingClient, type EmbeddingClient } from '../indexer/embed.js';
import {
  cosineSimilarity,
  type DedupedCandidateWithEmbedding,
} from './dedupe.js';
import type {
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
} from './types.js';

const W_VALUE = 0.4;
const W_INV_DIFFICULTY = 0.3;
const W_ALIGNMENT = 0.3;

/** Drop the bottom 80% of NOT-dropped candidates by composite_score. */
const BOTTOM_DROP_FRACTION = 0.8;

export interface ScorerDeps {
  embeddingClient?: EmbeddingClient;
  /** Sink for the telemetry JSON line. Default = process.stderr.write. */
  telemetrySink?: (line: string) => void;
  warn?: (line: string) => void;
}

export async function scoreCandidates(
  candidates: DedupedCandidate[],
  ctx: ProposerContext,
  cfg: ProposerConfig,
  deps: ScorerDeps = {},
): Promise<DedupedCandidate[]> {
  const warn = deps.warn ?? defaultWarn;
  const telemetry = deps.telemetrySink ?? defaultTelemetry;

  if (candidates.length === 0) {
    emitTelemetry(telemetry, {
      event: 'proposer_run',
      repo_id: cfg.repoId,
      candidates_in: 0,
      candidates_kept: 0,
      force_explored: 0,
      highest_score: 0,
      lowest_kept_score: 0,
    });
    return [];
  }

  const sprintEmbedding = await maybeEmbedSprint(ctx, cfg, deps, warn);

  // Stage 1: attach sprint_alignment + composite_score to every candidate
  // (including ones dedupe already dropped — observability wins, and the
  // budget gate filters dropped entries anyway).
  const withScores: DedupedCandidateWithEmbedding[] = candidates.map((c) => {
    const candidateEmbedding = (c as DedupedCandidateWithEmbedding).__embedding;
    const alignment =
      sprintEmbedding && candidateEmbedding
        ? clamp01(cosineSimilarity(sprintEmbedding, candidateEmbedding))
        : 0;
    const composite =
      W_VALUE * c.estimated_value +
      W_INV_DIFFICULTY * (1 - c.estimated_difficulty) +
      W_ALIGNMENT * alignment;
    const next: DedupedCandidateWithEmbedding = {
      ...c,
      sprint_alignment: alignment,
      composite_score: clamp01(composite),
    };
    if (candidateEmbedding) {
      Object.defineProperty(next, '__embedding', {
        value: candidateEmbedding,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    return next;
  });

  // Stage 2: drop bottom 80% of NOT-already-dropped (and not force-explore).
  // Force-explore entries — flagged by dedupe with reason starting "force-explore"
  // — are protected so the bandit signal survives.
  const protectedAlive: DedupedCandidateWithEmbedding[] = [];
  const otherAlive: DedupedCandidateWithEmbedding[] = [];
  for (const c of withScores) {
    if (c.dropped) continue;
    if (c.reason && c.reason.startsWith('force-explore')) {
      protectedAlive.push(c);
    } else {
      otherAlive.push(c);
    }
  }

  otherAlive.sort((a, b) => b.composite_score - a.composite_score);
  const keepCount = Math.max(1, Math.ceil(otherAlive.length * (1 - BOTTOM_DROP_FRACTION)));
  for (let i = 0; i < otherAlive.length; i += 1) {
    if (i < keepCount) continue;
    const target = otherAlive[i]!;
    target.dropped = true;
    target.reason = `low_score (composite=${target.composite_score.toFixed(3)})`;
  }

  // Stage 3: emit telemetry. `candidates_in` is the raw input size; `_kept`
  // counts entries surviving both dedupe + scorer (what budget consumes).
  const kept = withScores.filter((c) => !c.dropped);
  const forceExplored = withScores.filter(
    (c) => c.reason && c.reason.startsWith('force-explore'),
  ).length;
  const scores = kept.map((c) => c.composite_score);
  emitTelemetry(telemetry, {
    event: 'proposer_run',
    repo_id: cfg.repoId,
    candidates_in: candidates.length,
    candidates_kept: kept.length,
    force_explored: forceExplored,
    highest_score: scores.length === 0 ? 0 : Math.max(...scores),
    lowest_kept_score: scores.length === 0 ? 0 : Math.min(...scores),
  });

  return withScores;
}

async function maybeEmbedSprint(
  ctx: ProposerContext,
  _cfg: ProposerConfig,
  deps: ScorerDeps,
  warn: (line: string) => void,
): Promise<number[] | null> {
  const sprintText = ctx.sprintMd.trim();
  if (sprintText.length === 0) return null;
  let client: EmbeddingClient | null;
  try {
    client = deps.embeddingClient ?? createEmbeddingClient();
  } catch (err) {
    warn(`proposer/scorer: embedding provider unavailable for SPRINT alignment (${reason(err)})`);
    return null;
  }
  // _cfg.embeddingModel is reserved for future per-call overrides.
  try {
    const truncated = sprintText.length > 8000 ? sprintText.slice(0, 8000) : sprintText;
    const out = await client.embedBatch([truncated]);
    return out[0] ?? null;
  } catch (err) {
    warn(`proposer/scorer: SPRINT.md embedding failed (${reason(err)}) — alignment=0`);
    return null;
  }
}

interface ProposerRunTelemetry {
  event: 'proposer_run';
  repo_id: string;
  candidates_in: number;
  candidates_kept: number;
  force_explored: number;
  highest_score: number;
  lowest_kept_score: number;
}

function emitTelemetry(sink: (line: string) => void, payload: ProposerRunTelemetry): void {
  sink(`[PROPOSER-TELEMETRY] ${JSON.stringify(payload)}`);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWarn(line: string): void {
  console.warn(line);
}

function defaultTelemetry(line: string): void {
  console.error(line);
}
