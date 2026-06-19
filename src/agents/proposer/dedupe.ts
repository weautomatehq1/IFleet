// M5 Proposer — semantic dedupe (Lane T4).
//
// Embeds every fresh candidate and the titles of last-30d past proposals via
// the M3 embedding provider (Voyage if VOYAGE_API_KEY is set, else
// Transformers.js — both pad to 1536 dims). Marks a candidate `dropped` when
// `nearest_neighbor_sim >= cfg.dedupThreshold` and force-explores ONE dropped
// candidate per run (bandit-style) so the system never stops trying nearby
// variants.
//
// We store the candidate's embedding back on each returned object via a
// runtime-only field (`__embedding`) so the scorer can compute SPRINT-md
// alignment without re-billing the embedding API.

import { createEmbeddingClient, type EmbeddingClient } from '../indexer/embed.js';
import type {
  Candidate,
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
} from './types.js';

/**
 * Runtime-attached embedding cache. Not part of the public {@link DedupedCandidate}
 * shape — purely a side channel so the scorer can reuse what dedupe paid for.
 * Marked optional + structural so adding it never violates the type contract.
 */
export type DedupedCandidateWithEmbedding = DedupedCandidate & {
  /** Embedding of `title + rationale`. Undefined when the provider failed. */
  __embedding?: number[];
};

export interface DedupeDeps {
  /** Embedding client factory. Default = createEmbeddingClient (Voyage or Transformers.js). */
  embeddingClient?: EmbeddingClient;
  /** PRNG for force-explore selection. Defaults to Math.random. Inject for tests. */
  rng?: () => number;
  /** Logging sink — default console.warn. */
  warn?: (line: string) => void;
}

export async function dedupeCandidates(
  candidates: Candidate[],
  ctx: ProposerContext,
  cfg: ProposerConfig,
  deps: DedupeDeps = {},
): Promise<DedupedCandidate[]> {
  if (candidates.length === 0) return [];

  const warn = deps.warn ?? defaultWarn;
  const rng = deps.rng ?? Math.random;
  const client = deps.embeddingClient ?? safeCreateClient(warn);

  const candidateTexts = candidates.map((c) => `${c.title}\n\n${c.rationale}`);
  const pastTexts = ctx.pastProposals.map((p) => p.title);

  let candidateEmbeddings: Array<number[] | null> = candidates.map(() => null);
  let pastEmbeddings: Array<number[] | null> = pastTexts.map(() => null);

  if (client) {
    try {
      candidateEmbeddings = await client.embedBatch(candidateTexts);
    } catch (err) {
      warn(`proposer/dedupe: embed candidates failed (${reason(err)}) — assigning sim=0`);
    }
    if (pastTexts.length > 0) {
      try {
        pastEmbeddings = await client.embedBatch(pastTexts);
      } catch (err) {
        warn(`proposer/dedupe: embed past proposals failed (${reason(err)}) — sim against past skipped`);
      }
    }
  } else {
    warn('proposer/dedupe: no embedding client available — falling back to sim=0 (force-explore disabled)');
  }

  const pastVectors = pastEmbeddings.filter((v): v is number[] => Array.isArray(v));

  const decorated: DedupedCandidateWithEmbedding[] = candidates.map((c, idx) => {
    const embedding = candidateEmbeddings[idx];
    let sim = 0;
    if (embedding && pastVectors.length > 0) {
      sim = maxCosine(embedding, pastVectors);
    }
    const dropped = sim >= cfg.dedupThreshold;
    const out: DedupedCandidateWithEmbedding = {
      ...c,
      sprint_alignment: 0,
      composite_score: 0,
      nearest_neighbor_sim: sim,
      dropped,
    };
    if (dropped) {
      out.reason = `duplicate (sim=${sim.toFixed(3)})`;
    }
    if (embedding) {
      Object.defineProperty(out, '__embedding', {
        value: embedding,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    return out;
  });

  // Bandit-style force-explore: of the dropped set, randomly resurrect one.
  // Only applies when there's >= 1 dropped candidate AND >= 1 kept candidate
  // — if everything is dropped, force-exploring is meaningless because the
  // downstream scorer drops the bottom 80% anyway.
  const droppedIndices: number[] = [];
  for (let i = 0; i < decorated.length; i += 1) {
    if (decorated[i]!.dropped) droppedIndices.push(i);
  }
  if (droppedIndices.length > 0) {
    const pick = droppedIndices[Math.floor(rng() * droppedIndices.length)]!;
    const target = decorated[pick]!;
    target.dropped = false;
    target.reason = `force-explore (was sim=${target.nearest_neighbor_sim.toFixed(3)})`;
  }

  return decorated;
}

function safeCreateClient(warn: (line: string) => void): EmbeddingClient | null {
  try {
    return createEmbeddingClient();
  } catch (err) {
    warn(`proposer/dedupe: embedding provider unavailable (${reason(err)})`);
    return null;
  }
}

// Exported for tests.
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function maxCosine(target: number[], pool: number[][]): number {
  let best = 0;
  for (const vec of pool) {
    const sim = cosineSimilarity(target, vec);
    if (sim > best) best = sim;
  }
  return best;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultWarn(line: string): void {
   
  console.warn(line);
}
