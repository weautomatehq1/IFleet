// Unit tests for scorer — covers composite score deterministic computation,
// bottom-80% drop, force-explore protection, telemetry emission, and the
// SPRINT-alignment fallback when no embedding is available.

import { describe, expect, it, vi } from 'vitest';

import { scoreCandidates } from '../scorer.ts';
import type { EmbeddingClient } from '../../indexer/embed.ts';
import type {
  DedupedCandidate,
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

function baseCtx(sprintMd = 'Sprint goal: implement M5 Proposer.'): ProposerContext {
  return {
    repoId: cfg.repoId,
    repoRoot: cfg.repoRoot,
    sprintMd,
    roadmapMd: '',
    nonGoalsMd: '',
    learnings: [],
    recentDoctorFingerprints: [],
    recentPrDecisions: [],
    pastProposals: [],
    loadedAt: '2026-06-04T13:44:49Z',
  };
}

function mkDeduped(
  title: string,
  value: number,
  difficulty: number,
  embedding?: number[],
  overrides: Partial<DedupedCandidate> = {},
): DedupedCandidate {
  const base: DedupedCandidate = {
    title,
    rationale: `r-${title}`,
    estimated_value: value,
    estimated_difficulty: difficulty,
    source: 'sprint_gap',
    sprint_alignment: 0,
    composite_score: 0,
    nearest_neighbor_sim: 0,
    dropped: false,
    ...overrides,
  };
  if (embedding) {
    Object.defineProperty(base, '__embedding', {
      value: embedding,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return base;
}

describe('scoreCandidates', () => {
  it('attaches deterministic composite_score = 0.4*value + 0.3*(1-difficulty) + 0.3*alignment', async () => {
    const sprintEmbedding = [1, 0];
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockResolvedValue([sprintEmbedding]),
    };

    // Single candidate so it survives the bottom-80% drop (ceil(1*0.2)=1 kept).
    const candidate = mkDeduped('A', 0.8, 0.2, [1, 0]);

    const sink = vi.fn();
    const result = await scoreCandidates([candidate], baseCtx(), cfg, {
      embeddingClient: client,
      telemetrySink: sink,
    });

    expect(result).toHaveLength(1);
    const scored = result[0]!;
    // alignment = cosine([1,0],[1,0]) = 1
    // composite = 0.4*0.8 + 0.3*(1-0.2) + 0.3*1 = 0.32 + 0.24 + 0.30 = 0.86
    expect(scored.sprint_alignment).toBeCloseTo(1);
    expect(scored.composite_score).toBeCloseTo(0.86);
    expect(scored.dropped).toBe(false);
  });

  it('drops the bottom 80% by composite_score', async () => {
    const sprintEmbedding = [1, 0];
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockResolvedValue([sprintEmbedding]),
    };
    // Ten candidates, descending value — composite is monotonic in value so
    // the top 2 (ceil(10*0.2)=2) should survive.
    const candidates: DedupedCandidate[] = Array.from({ length: 10 }, (_, i) =>
      mkDeduped(`T${i}`, (10 - i) / 10, 0.5, [1, 0]),
    );

    const result = await scoreCandidates(candidates, baseCtx(), cfg, {
      embeddingClient: client,
      telemetrySink: () => {},
    });

    const kept = result.filter((c) => !c.dropped);
    expect(kept).toHaveLength(2);
    expect(kept.map((c) => c.title)).toEqual(['T0', 'T1']);
    for (const c of result) {
      if (c.dropped) {
        expect(c.reason ?? '').toMatch(/^low_score/);
      }
    }
  });

  it('protects force-explore candidates from the bottom-80% drop', async () => {
    const sprintEmbedding = [1, 0];
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockResolvedValue([sprintEmbedding]),
    };
    // The force-explore entry has the worst value but should still survive.
    const candidates: DedupedCandidate[] = [
      mkDeduped('Top', 1, 0, [1, 0]),
      mkDeduped('Mid', 0.6, 0.4, [1, 0]),
      mkDeduped('LowFE', 0.0, 1, [1, 0], { reason: 'force-explore (was sim=0.910)' }),
      mkDeduped('LowOther', 0.1, 0.9, [1, 0]),
      mkDeduped('LowOther2', 0.1, 0.9, [1, 0]),
    ];

    const result = await scoreCandidates(candidates, baseCtx(), cfg, {
      embeddingClient: client,
      telemetrySink: () => {},
    });

    const kept = result.filter((c) => !c.dropped);
    const titles = kept.map((c) => c.title).sort();
    // Top + LowFE always kept (force-explore protected). With 4 non-FE entries,
    // ceil(4 * 0.2) = 1 of those survives — the highest-scoring 'Top'.
    expect(titles).toContain('Top');
    expect(titles).toContain('LowFE');
  });

  it('emits one telemetry line with the proposer_run event shape', async () => {
    const sprintEmbedding = [1, 0];
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockResolvedValue([sprintEmbedding]),
    };
    const candidates = [
      mkDeduped('A', 0.9, 0.1, [1, 0]),
      mkDeduped('B', 0.1, 0.9, [1, 0]),
    ];
    const lines: string[] = [];
    await scoreCandidates(candidates, baseCtx(), cfg, {
      embeddingClient: client,
      telemetrySink: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PROPOSER-TELEMETRY\] /);
    const payload = JSON.parse(lines[0]!.replace('[PROPOSER-TELEMETRY] ', ''));
    expect(payload.event).toBe('proposer_run');
    expect(payload.repo_id).toBe(cfg.repoId);
    expect(payload.candidates_in).toBe(2);
    expect(typeof payload.candidates_kept).toBe('number');
    expect(typeof payload.highest_score).toBe('number');
  });

  it('falls back to alignment=0 when SPRINT.md is empty', async () => {
    const client: EmbeddingClient = {
      embedBatch: vi.fn().mockResolvedValue([[1, 0]]),
    };
    const candidate = mkDeduped('A', 0.5, 0.5, [1, 0]);
    const result = await scoreCandidates([candidate], baseCtx(''), cfg, {
      embeddingClient: client,
      telemetrySink: () => {},
    });
    expect(client.embedBatch).not.toHaveBeenCalled();
    expect(result[0]!.sprint_alignment).toBe(0);
    // composite = 0.4*0.5 + 0.3*0.5 + 0 = 0.35
    expect(result[0]!.composite_score).toBeCloseTo(0.35);
  });

  it('returns [] and emits zero-shape telemetry on empty input', async () => {
    const lines: string[] = [];
    const result = await scoreCandidates([], baseCtx(), cfg, {
      telemetrySink: (l) => lines.push(l),
    });
    expect(result).toEqual([]);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!.replace('[PROPOSER-TELEMETRY] ', ''));
    expect(payload.candidates_in).toBe(0);
    expect(payload.candidates_kept).toBe(0);
  });
});
