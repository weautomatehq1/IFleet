// Unit tests for candidate-gen.
//
// We never touch the Anthropic API here — the LlmCompleter seam lets us
// inject a deterministic stub that returns canned JSON. The tests cover the
// happy path, the JSON-extraction tolerance, NON_GOALS exclusion, and the
// past-proposal title de-duplication.

import { describe, expect, it, vi } from 'vitest';

import {
  generateCandidates,
  parseCandidatesArray,
  type LlmCompleter,
} from '../candidate-gen.js';
import type {
  ProposerConfig,
  ProposerContext,
} from '../types.js';

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
    sprintMd: 'Sprint goal: ship M5 Proposer.',
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

function stubLlm(response: string): LlmCompleter {
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe('parseCandidatesArray', () => {
  it('extracts a balanced JSON array from a prose-wrapped response', () => {
    const raw =
      'Here are some candidates:\n```json\n[ {"title":"A","rationale":"x"} ]\n```\nLet me know.';
    expect(parseCandidatesArray(raw)).toEqual([{ title: 'A', rationale: 'x' }]);
  });

  it('handles nested arrays/strings without confusing depth tracking', () => {
    const raw =
      '[{"title":"A","rationale":"with [brackets]","examples":["one","two"]}]';
    const parsed = parseCandidatesArray(raw);
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { title: string }).title).toBe('A');
  });

  it('returns [] when no array can be parsed', () => {
    expect(parseCandidatesArray('no JSON here')).toEqual([]);
    expect(parseCandidatesArray('[malformed')).toEqual([]);
  });
});

describe('generateCandidates', () => {
  it('parses Haiku JSON into Candidates, clamping numeric fields', async () => {
    const response = JSON.stringify([
      {
        title: 'Add Semgrep rule for direct Supabase calls',
        rationale: 'Repeated rejection of cross-boundary PRs.',
        estimated_value: 0.7,
        estimated_difficulty: 0.3,
        source: 'learnings',
      },
      {
        title: 'Fix flaky verifier test',
        rationale: 'Doctor fingerprint hits every other run.',
        estimated_value: 1.4, // clamped to 1
        estimated_difficulty: -0.2, // clamped to 0
        source: 'unknown', // normalized to 'sprint_gap'
      },
    ]);

    const result = await generateCandidates(baseCtx(), cfg, { llm: stubLlm(response) });

    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe('Add Semgrep rule for direct Supabase calls');
    expect(result[0]!.source).toBe('learnings');
    expect(result[1]!.estimated_value).toBe(1);
    expect(result[1]!.estimated_difficulty).toBe(0);
    expect(result[1]!.source).toBe('sprint_gap');
  });

  it('skips candidates whose title matches a past proposal (case-insensitive)', async () => {
    const response = JSON.stringify([
      { title: 'Already tried', rationale: 'x', estimated_value: 0.5, estimated_difficulty: 0.5, source: 'sprint_gap' },
      { title: 'Fresh idea', rationale: 'y', estimated_value: 0.5, estimated_difficulty: 0.5, source: 'sprint_gap' },
    ]);

    const result = await generateCandidates(
      baseCtx({
        pastProposals: [
          {
            id: 'p1',
            proposedAt: Date.now(),
            source: 'sprint_gap',
            title: 'ALREADY TRIED',
            decision: 'approved',
            resultingPrOutcome: 'merged',
          },
        ],
      }),
      cfg,
      { llm: stubLlm(response) },
    );

    expect(result.map((c) => c.title)).toEqual(['Fresh idea']);
  });

  it('skips candidates whose title overlaps a NON_GOALS line', async () => {
    const response = JSON.stringify([
      { title: 'Build marketing landing page', rationale: 'x', estimated_value: 0.5, estimated_difficulty: 0.5, source: 'sprint_gap' },
      { title: 'Refactor proposer pipeline', rationale: 'y', estimated_value: 0.5, estimated_difficulty: 0.5, source: 'sprint_gap' },
    ]);

    const result = await generateCandidates(
      baseCtx({ nonGoalsMd: '- marketing landing page\n- Stripe integration\n' }),
      cfg,
      { llm: stubLlm(response) },
    );

    expect(result.map((c) => c.title)).toEqual(['Refactor proposer pipeline']);
  });

  it('returns [] and warns when the Haiku call throws', async () => {
    const warns: string[] = [];
    const llm: LlmCompleter = {
      complete: vi.fn().mockRejectedValue(new Error('rate limited')),
    };
    const result = await generateCandidates(baseCtx(), cfg, {
      llm,
      warn: (l) => warns.push(l),
    });
    expect(result).toEqual([]);
    expect(warns.some((l) => /Haiku call failed/.test(l))).toBe(true);
  });

  it('caps output at 20 even when Haiku returns more', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `T${i}`,
      rationale: 'r',
      estimated_value: 0.5,
      estimated_difficulty: 0.5,
      source: 'sprint_gap',
    }));
    const result = await generateCandidates(baseCtx(), cfg, {
      llm: stubLlm(JSON.stringify(items)),
    });
    expect(result).toHaveLength(20);
  });
});

describe('buildUserPrompt — past-proposal buckets', () => {
  function promptCapturingLlm() {
    let captured = '';
    const llm: LlmCompleter = {
      complete: vi.fn().mockImplementation(async (opts) => {
        captured = opts.userPrompt;
        return '[]';
      }),
    };
    return { llm, getPrompt: () => captured };
  }

  it('all four buckets populated — each header and title present', async () => {
    const { llm, getPrompt } = promptCapturingLlm();
    await generateCandidates(
      baseCtx({
        pastProposals: [
          { id: 'p1', proposedAt: 1, source: 'sprint_gap', title: 'Shipped feat', decision: 'approved', resultingPrOutcome: 'merged' },
          { id: 'p2', proposedAt: 2, source: 'sprint_gap', title: 'Rejected PR', decision: 'approved', resultingPrOutcome: 'closed_unmerged' },
          { id: 'p3', proposedAt: 3, source: 'sprint_gap', title: 'Human vetoed', decision: 'rejected', resultingPrOutcome: null },
          { id: 'p4', proposedAt: 4, source: 'sprint_gap', title: 'WIP task', decision: 'approved', resultingPrOutcome: null },
        ],
      }),
      cfg,
      { llm },
    );
    const prompt = getPrompt();
    expect(prompt).toContain('### MERGED');
    expect(prompt).toContain('"Shipped feat"');
    expect(prompt).toContain('### CLOSED_UNMERGED');
    expect(prompt).toContain('"Rejected PR"');
    expect(prompt).toContain('### REJECTED_AT_HITL');
    expect(prompt).toContain('"Human vetoed"');
    expect(prompt).toContain("### IN_FLIGHT");
    expect(prompt).toContain('"WIP task"');
  });

  it('single bucket populated — other three emit (none)', async () => {
    const { llm, getPrompt } = promptCapturingLlm();
    await generateCandidates(
      baseCtx({
        pastProposals: [
          { id: 'p1', proposedAt: 1, source: 'sprint_gap', title: 'Solo merged', decision: 'approved', resultingPrOutcome: 'merged' },
        ],
      }),
      cfg,
      { llm },
    );
    const prompt = getPrompt();
    expect(prompt).toContain('"Solo merged"');
    // The three empty buckets must all appear with (none)
    const closedBlock = prompt.slice(prompt.indexOf('### CLOSED_UNMERGED'));
    expect(closedBlock).toMatch(/### CLOSED_UNMERGED[^\n]*\n\(none\)/);
    const hitlBlock = prompt.slice(prompt.indexOf('### REJECTED_AT_HITL'));
    expect(hitlBlock).toMatch(/### REJECTED_AT_HITL[^\n]*\n\(none\)/);
    const inflightBlock = prompt.slice(prompt.indexOf('### IN_FLIGHT'));
    expect(inflightBlock).toMatch(/### IN_FLIGHT[^\n]*\n\(none\)/);
  });

  it('all-empty — all four headers present with (none)', async () => {
    const { llm, getPrompt } = promptCapturingLlm();
    await generateCandidates(baseCtx({ pastProposals: [] }), cfg, { llm });
    const prompt = getPrompt();
    for (const header of ['### MERGED', '### CLOSED_UNMERGED', '### REJECTED_AT_HITL', '### IN_FLIGHT']) {
      expect(prompt).toContain(header);
    }
    // Each header is immediately followed by (none)
    expect(prompt.match(/\(none\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('30-cap applied before bucketing — items 31+ are ignored', async () => {
    const { llm, getPrompt } = promptCapturingLlm();
    const proposals = Array.from({ length: 35 }, (_, i) => ({
      id: `p${i}`,
      proposedAt: i,
      source: 'sprint_gap' as const,
      // items 0-29 → in-flight; items 30-34 → merged (should be excluded by cap)
      title: i < 30 ? `InFlight-${i}` : `ShouldBeDropped-${i}`,
      decision: null,
      resultingPrOutcome: i < 30 ? null : ('merged' as const),
    }));
    await generateCandidates(baseCtx({ pastProposals: proposals }), cfg, { llm });
    const prompt = getPrompt();
    // Items 30-34 have resultingPrOutcome=merged, but they're beyond the cap
    expect(prompt).not.toContain('ShouldBeDropped');
    // MERGED bucket should be empty
    const mergedBlock = prompt.slice(prompt.indexOf('### MERGED'));
    expect(mergedBlock).toMatch(/### MERGED[^\n]*\n\(none\)/);
  });
});
