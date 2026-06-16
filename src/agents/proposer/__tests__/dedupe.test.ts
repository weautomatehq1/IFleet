// Unit tests for dedupe — covers cosine math, threshold-based drop, the
// force-explore bandit, the no-past-proposals fast path, and the
// embedding-provider-down failure mode.

import { describe, expect, it, vi } from 'vitest';

import { cosineSimilarity, dedupeCandidates } from '../dedupe.ts';
import type { EmbeddingClient } from '../../indexer/embed.ts';
import type {
  Candidate,
  ProposerConfig,
  ProposerContext,
} from '../types.ts';

const cfg: ProposerConfig = {
  repoId: 'weautomatehq1/IFleet',
  repoRoot: '/tmp/none',
  budget: 3,
  hardMax: 10,
  windowDays: 7,
  pastProposalsWindowDays: 30,
  embeddingModel: 'text-embedding-3-small',
  dedupThreshold: 0.85,
};

function baseCtx(overrides: Partial<ProposerContext> = {}): ProposerContext {
  return {
    repoId: cfg.repoId,
    repoRoot: cfg.repoRoot,
    sprintMd: '',
    roadmapMd: '',
    nonGoalsMd: '',
    learnings: [],
    recentDoctorFingerprints: [],
    recentPrDecisions: [],
    pastProposals: [],
    loadedAt: '2026-06-04T13:44:49Z',
    ...overrides,
  };
}

function makeCandidate(title: string, rationale = 'r'): Candidate {
  return {
    title,
    rationale,
    estimated_value: 0.5,
    estimated_difficulty: 0.5,
    source: 'sprint_gap',
  };
}

/**
 * Mock embedding client driven by a text→vector map. Unknown inputs fall
 * back to an orthogonal vector so they don't accidentally collide.
 */
function mockEmbeddingClient(map: Record<string, number[]>, fallbackDim = 4): EmbeddingClient {
  let fallbackIdx = 0;
  return {
    embedBatch: vi.fn().mockImplementation(async (inputs: ReadonlyArray<string>) =>
      inputs.map((text) => {
        const direct = map[text];
        if (direct) return direct;
        for (const key of Object.keys(map)) {
          if (text.includes(key)) return map[key]!;
        }
        // Distinct orthogonal one-hot for unknown text.
        const vec = new Array<number>(fallbackDim).fill(0);
        vec[fallbackIdx % fallbackDim] = 1;
        fallbackIdx += 1;
        return vec;
      }),
    ),
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('returns 0 when either vector is empty / zero', () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('dedupeCandidates', () => {
  it('flags near-duplicates above the threshold as dropped', async () => {
    const dupVec = [1, 0, 0, 0];
    const newVec = [0, 1, 0, 0];

    const client = mockEmbeddingClient({
      'Existing topic\n\nr': dupVec, // candidate-side key uses title+rationale
      'Fresh topic\n\nr': newVec,
      'Existing topic': dupVec, // past-proposal-side key uses just title
    });

    const candidates: Candidate[] = [
      makeCandidate('Existing topic'),
      makeCandidate('Fresh topic'),
    ];

    const ctx = baseCtx({
      pastProposals: [
        {
          id: 'p1',
          proposedAt: Date.now(),
          source: 'sprint_gap',
          title: 'Existing topic',
          decision: 'approved',
          resultingPrOutcome: 'merged',
        },
      ],
    });

    const result = await dedupeCandidates(candidates, ctx, cfg, {
      embeddingClient: client,
      rng: () => 0, // pick the first dropped index for force-explore
    });

    expect(result).toHaveLength(2);
    const existing = result.find((c) => c.title === 'Existing topic')!;
    const fresh = result.find((c) => c.title === 'Fresh topic')!;
    // Existing got force-explored back since it was the only dropped entry.
    expect(existing.dropped).toBe(false);
    expect(existing.reason ?? '').toMatch(/^force-explore/);
    expect(existing.nearest_neighbor_sim).toBeCloseTo(1);
    expect(fresh.dropped).toBe(false);
    expect(fresh.nearest_neighbor_sim).toBeCloseTo(0);
  });

  it('only force-explores once per run even when multiple candidates exceed threshold', async () => {
    const dupVec = [1, 0, 0, 0];
    const client = mockEmbeddingClient({
      'A\n\nr': dupVec,
      'B\n\nr': dupVec,
      'C\n\nr': dupVec,
      Past: dupVec,
    });
    const candidates = [makeCandidate('A'), makeCandidate('B'), makeCandidate('C')];
    const ctx = baseCtx({
      pastProposals: [
        {
          id: 'p1',
          proposedAt: Date.now(),
          source: 'sprint_gap',
          title: 'Past',
          decision: 'approved',
          resultingPrOutcome: 'merged',
        },
      ],
    });

    const result = await dedupeCandidates(candidates, ctx, cfg, {
      embeddingClient: client,
      rng: () => 0,
    });

    const promoted = result.filter((c) => !c.dropped);
    const dropped = result.filter((c) => c.dropped);
    expect(promoted).toHaveLength(1);
    expect(dropped).toHaveLength(2);
    expect(promoted[0]!.reason ?? '').toMatch(/^force-explore/);
  });

  it('handles empty pastProposals — every candidate kept with sim=0', async () => {
    const client = mockEmbeddingClient({ 'X\n\nr': [1, 0], 'Y\n\nr': [0, 1] });
    const result = await dedupeCandidates(
      [makeCandidate('X'), makeCandidate('Y')],
      baseCtx(),
      cfg,
      { embeddingClient: client },
    );
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.nearest_neighbor_sim === 0)).toBe(true);
    expect(result.every((c) => !c.dropped)).toBe(true);
  });

  it('falls back to sim=0 + warns when the embedding provider throws', async () => {
    const warns: string[] = [];
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockRejectedValue(new Error('provider down')),
    };
    const result = await dedupeCandidates(
      [makeCandidate('A')],
      baseCtx({
        pastProposals: [
          {
            id: 'p1',
            proposedAt: Date.now(),
            source: 'sprint_gap',
            title: 'Past',
            decision: 'approved',
            resultingPrOutcome: 'merged',
          },
        ],
      }),
      cfg,
      { embeddingClient: client, warn: (l) => warns.push(l), rng: () => 0 },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.dropped).toBe(false);
    expect(result[0]!.nearest_neighbor_sim).toBe(0);
    expect(warns.some((l) => /embed candidates failed/.test(l))).toBe(true);
  });

  it('attaches __embedding as a non-enumerable field for scorer reuse', async () => {
    const client = mockEmbeddingClient({ 'X\n\nr': [0.1, 0.9, 0, 0] });
    const result = await dedupeCandidates([makeCandidate('X')], baseCtx(), cfg, {
      embeddingClient: client,
    });
    expect(result).toHaveLength(1);
    const c = result[0] as { __embedding?: number[] };
    expect(c.__embedding).toEqual([0.1, 0.9, 0, 0]);
    // Non-enumerable means JSON.stringify hides it — the public DedupedCandidate
    // shape is what consumers see.
    const serialised = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    expect('__embedding' in serialised).toBe(false);
  });
});
