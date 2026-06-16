// Skeleton-level orchestration tests for runProposer.
//
// The real T4 / T5 modules throw from their stubs (Lane T4/T5 not landed
// yet), so the orchestrator's contract is exercised by injecting stage
// overrides via `RunProposerOptions.stages`. We assert (a) the 6-step
// sequence fires in order, (b) the `ProposerRun` return shape, and (c) that
// each stage receives the output of the previous one.

import { describe, it, expect } from 'vitest';

import { runProposer } from '../index.js';
import type {
  Candidate,
  DedupedCandidate,
  ProposerConfig,
  ProposerContext,
} from '../types.js';

const baseCfg: ProposerConfig = {
  repoId: 'weautomatehq1/IFleet',
  repoRoot: '/nonexistent',
  budget: 3,
  hardMax: 10,
  windowDays: 7,
  pastProposalsWindowDays: 30,
  embeddingModel: 'text-embedding-3-small',
  dedupThreshold: 0.85,
};

function emptyContext(): ProposerContext {
  return {
    repoId: baseCfg.repoId,
    repoRoot: baseCfg.repoRoot,
    sprintMd: '',
    roadmapMd: '',
    nonGoalsMd: '',
    learnings: [],
    recentDoctorFingerprints: [],
    recentPrDecisions: [],
    pastProposals: [],
    loadedAt: '2026-06-04T09:00:00.000Z',
  };
}

function candidate(title: string): Candidate {
  return {
    title,
    rationale: `rationale for ${title}`,
    estimated_value: 0.5,
    estimated_difficulty: 0.3,
    source: 'sprint_gap',
  };
}

function dedupedFrom(c: Candidate, composite_score = 0.7): DedupedCandidate {
  return {
    ...c,
    sprint_alignment: 0.8,
    composite_score,
    nearest_neighbor_sim: 0.1,
    dropped: false,
  };
}

describe('runProposer orchestration', () => {
  it('calls every stage exactly once in spec order and threads outputs through', async () => {
    const calls: string[] = [];

    const ctx = emptyContext();
    const generated: Candidate[] = [candidate('A'), candidate('B')];
    const deduped: DedupedCandidate[] = [dedupedFrom(generated[0]!), dedupedFrom(generated[1]!)];
    const scored: DedupedCandidate[] = deduped.map((c) => ({ ...c, composite_score: 0.9 }));
    const top: DedupedCandidate[] = [scored[0]!];

    const run = await runProposer(baseCfg.repoId, baseCfg, {
      stages: {
        async loadContext(repoId, cfg) {
          calls.push('loadContext');
          expect(repoId).toBe(baseCfg.repoId);
          expect(cfg).toBe(baseCfg);
          return ctx;
        },
        async generateCandidates(c, cfg) {
          calls.push('generateCandidates');
          expect(c).toBe(ctx);
          expect(cfg).toBe(baseCfg);
          return generated;
        },
        async dedupeCandidates(cands, c, cfg) {
          calls.push('dedupeCandidates');
          expect(cands).toBe(generated);
          expect(c).toBe(ctx);
          expect(cfg).toBe(baseCfg);
          return deduped;
        },
        async scoreCandidates(cands, c, cfg) {
          calls.push('scoreCandidates');
          expect(cands).toBe(deduped);
          expect(c).toBe(ctx);
          expect(cfg).toBe(baseCfg);
          return scored;
        },
        async enforceBudget(cands, cfg) {
          calls.push('enforceBudget');
          expect(cands).toBe(scored);
          expect(cfg).toBe(baseCfg);
          return top;
        },
        async dispatchProposals(cands, cfg) {
          calls.push('dispatchProposals');
          expect(cands).toBe(top);
          expect(cfg).toBe(baseCfg);
          return 1;
        },
      },
    });

    expect(calls).toEqual([
      'loadContext',
      'generateCandidates',
      'dedupeCandidates',
      'scoreCandidates',
      'enforceBudget',
      'dispatchProposals',
    ]);
    expect(run.repoId).toBe(baseCfg.repoId);
    expect(run.posted).toBe(1);
    expect(run.candidates).toBe(top);
    expect(typeof run.runId).toBe('string');
    expect(run.runId.length).toBeGreaterThan(0);
    expect(typeof run.startedAt).toBe('string');
    expect(typeof run.finishedAt).toBe('string');
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
  });

  it('propagates a stage throw to the caller (no swallow)', async () => {
    await expect(
      runProposer(baseCfg.repoId, baseCfg, {
        stages: {
          async loadContext() {
            return emptyContext();
          },
          async generateCandidates() {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('falls back to real modules when no override is supplied — candidate-gen needs ANTHROPIC_API_KEY', async () => {
    // T4 has landed; candidate-gen now calls Anthropic via fetch, defaulting
    // its LlmCompleter to AnthropicCompleter. With ANTHROPIC_API_KEY unset,
    // the completer constructor throws — proving the default wiring still
    // resolves to the real T4 module (and not, e.g., a leftover stub).
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        runProposer(baseCfg.repoId, baseCfg, {
          contextDeps: { warn: () => {} },
        }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
