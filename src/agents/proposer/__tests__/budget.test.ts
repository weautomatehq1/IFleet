// Unit tests for budget — covers sort+slice, dropped-filtering, hardMax
// enforcement, and the absolute HARD_CEILING of 10.

import { describe, expect, it } from 'vitest';

import { enforceBudget } from '../budget.ts';
import type { DedupedCandidate, ProposerConfig } from '../types.ts';

function cfg(budget: number, hardMax: number): ProposerConfig {
  return {
    repoId: 'weautomatehq1/IFleet',
    repoRoot: '/tmp/none',
    budget,
    hardMax,
    windowDays: 7,
    pastProposalsWindowDays: 30,
    embeddingModel: 'text-embedding-3-small',
    dedupThreshold: 0.85,
  };
}

function mk(title: string, score: number, dropped = false): DedupedCandidate {
  return {
    title,
    rationale: 'r',
    estimated_value: 0.5,
    estimated_difficulty: 0.5,
    source: 'sprint_gap',
    sprint_alignment: 0.5,
    composite_score: score,
    nearest_neighbor_sim: 0,
    dropped,
  };
}

describe('enforceBudget', () => {
  it('returns top-N by composite_score (filters dropped, sorts desc)', async () => {
    const cands = [
      mk('A', 0.4),
      mk('B', 0.9),
      mk('C', 0.1, true), // dropped
      mk('D', 0.7),
      mk('E', 0.5),
    ];
    const result = await enforceBudget(cands, cfg(3, 10));
    expect(result.map((c) => c.title)).toEqual(['B', 'D', 'E']);
  });

  it('uses min(budget, hardMax) when hardMax is tighter', async () => {
    const cands = Array.from({ length: 5 }, (_, i) => mk(`T${i}`, 1 - i * 0.1));
    const result = await enforceBudget(cands, cfg(5, 2));
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.title)).toEqual(['T0', 'T1']);
  });

  it('enforces the absolute HARD_CEILING of 10 regardless of cfg.hardMax', async () => {
    const cands = Array.from({ length: 20 }, (_, i) => mk(`T${i}`, 1 - i * 0.01));
    const result = await enforceBudget(cands, cfg(50, 999));
    expect(result).toHaveLength(10);
  });

  it('returns [] when every candidate is dropped', async () => {
    const cands = [mk('A', 0.9, true), mk('B', 0.8, true)];
    expect(await enforceBudget(cands, cfg(3, 10))).toEqual([]);
  });

  it('returns [] when budget is zero', async () => {
    const cands = [mk('A', 0.9), mk('B', 0.8)];
    expect(await enforceBudget(cands, cfg(0, 10))).toEqual([]);
  });

  it('clamps negative budget / hardMax to 0', async () => {
    const cands = [mk('A', 0.9)];
    expect(await enforceBudget(cands, cfg(-3, 5))).toEqual([]);
    expect(await enforceBudget(cands, cfg(3, -1))).toEqual([]);
  });
});
