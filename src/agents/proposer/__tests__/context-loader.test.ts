// Fail-open assertions for loadProposerContext.
//
// Every source the loader touches has its own failure mode: missing file,
// missing reader dep, thrown reader. The loader MUST never throw — each
// failure produces an empty default and one warn line.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadProposerContext } from '../context-loader.ts';
import type {
  PastProposalSummary,
  PrDecisionSummary,
  ProposerConfig,
} from '../types.ts';

function makeCfg(repoRoot: string): ProposerConfig {
  return {
    repoId: 'weautomatehq1/IFleet',
    repoRoot,
    budget: 3,
    hardMax: 10,
    windowDays: 7,
    pastProposalsWindowDays: 30,
    embeddingModel: 'text-embedding-3-small',
    dedupThreshold: 0.85,
  };
}

describe('loadProposerContext', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ifleet-proposer-ctx-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('returns all-empty defaults when every source is missing — does NOT throw', async () => {
    const warns: string[] = [];
    const ctx = await loadProposerContext('weautomatehq1/IFleet', makeCfg(repoRoot), {
      warn: (l) => warns.push(l),
    });

    expect(ctx.repoId).toBe('weautomatehq1/IFleet');
    expect(ctx.repoRoot).toBe(repoRoot);
    expect(ctx.sprintMd).toBe('');
    expect(ctx.roadmapMd).toBe('');
    expect(ctx.nonGoalsMd).toBe('');
    expect(ctx.learnings).toEqual([]);
    expect(ctx.recentDoctorFingerprints).toEqual([]);
    expect(ctx.recentPrDecisions).toEqual([]);
    expect(ctx.pastProposals).toEqual([]);
    expect(typeof ctx.loadedAt).toBe('string');

    // One warn per missing source: SPRINT.md, ROADMAP.md, NON_GOALS.md,
    // learnings.md, fingerprints.json, pr_decisions reader not wired,
    // goal_proposals reader not wired — exactly 7 warns.
    expect(warns.length).toBe(7);
    expect(warns.some((l) => /SPRINT\.md/.test(l))).toBe(true);
    expect(warns.some((l) => /ROADMAP\.md/.test(l))).toBe(true);
    expect(warns.some((l) => /NON_GOALS\.md/.test(l))).toBe(true);
    expect(warns.some((l) => /learnings/.test(l))).toBe(true);
    expect(warns.some((l) => /fingerprints/.test(l))).toBe(true);
    expect(warns.some((l) => /pr_decisions/.test(l))).toBe(true);
    expect(warns.some((l) => /goal_proposals/.test(l))).toBe(true);
  });

  it('reads SPRINT.md/ROADMAP.md/NON_GOALS.md verbatim when they exist', async () => {
    await writeFile(join(repoRoot, 'SPRINT.md'), 'sprint goal text\n', 'utf8');
    await writeFile(join(repoRoot, 'ROADMAP.md'), '# roadmap\n', 'utf8');
    await writeFile(join(repoRoot, 'NON_GOALS.md'), 'no marketing site\n', 'utf8');

    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      { warn: () => {} },
    );

    expect(ctx.sprintMd).toBe('sprint goal text\n');
    expect(ctx.roadmapMd).toBe('# roadmap\n');
    expect(ctx.nonGoalsMd).toBe('no marketing site\n');
  });

  it('reads recent learnings via the pipeline learnings module', async () => {
    await mkdir(join(repoRoot, '.omc'), { recursive: true });
    await writeFile(
      join(repoRoot, '.omc', 'learnings.md'),
      '- 2026-06-01 09:00 | t1 | one\n- 2026-06-02 10:00 | t2 | two\n',
      'utf8',
    );

    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      { warn: () => {} },
    );

    expect(ctx.learnings).toEqual([
      '- 2026-06-01 09:00 | t1 | one',
      '- 2026-06-02 10:00 | t2 | two',
    ]);
  });

  it('reads + filters doctor fingerprints by windowDays', async () => {
    await mkdir(join(repoRoot, '.omc'), { recursive: true });
    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      join(repoRoot, '.omc', 'fingerprints.json'),
      JSON.stringify({
        aaaaaaaaaaaaaaaa: { first_seen: recent, count: 5, tag: 'TypeError: x' },
        bbbbbbbbbbbbbbbb: { first_seen: old, count: 1, tag: 'tsc: y' },
        cccccccccccccccc: { first_seen: recent, count: 12, tag: 'lint: z' },
      }),
      'utf8',
    );

    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      { warn: () => {} },
    );

    expect(ctx.recentDoctorFingerprints).toHaveLength(2);
    // Most-frequent first.
    expect(ctx.recentDoctorFingerprints[0]!.hash).toBe('cccccccccccccccc');
    expect(ctx.recentDoctorFingerprints[1]!.hash).toBe('aaaaaaaaaaaaaaaa');
    // Old fingerprint filtered out.
    expect(
      ctx.recentDoctorFingerprints.some((f) => f.hash === 'bbbbbbbbbbbbbbbb'),
    ).toBe(false);
  });

  it('filters pr_decisions to the 30d window via the injected reader', async () => {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;

    const rows: PrDecisionSummary[] = [
      {
        taskId: 't-recent',
        prNumber: 1,
        verdict: 'merged',
        reviewerLogin: 'alice',
        mergedAt: now,
        createdAt: now - 1000,
        fingerprint: null,
      },
      {
        taskId: 't-old',
        prNumber: 2,
        verdict: 'rejected',
        reviewerLogin: 'bob',
        mergedAt: null,
        createdAt: cutoff - 10_000,
        fingerprint: null,
      },
    ];

    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      {
        warn: () => {},
        prDecisionsByRepo: () => rows,
      },
    );

    expect(ctx.recentPrDecisions).toHaveLength(1);
    expect(ctx.recentPrDecisions[0]!.taskId).toBe('t-recent');
  });

  it('falls back to empty + warn when pr_decisions reader throws', async () => {
    const warns: string[] = [];
    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      {
        warn: (l) => warns.push(l),
        prDecisionsByRepo: () => {
          throw new Error('db unavailable');
        },
      },
    );

    expect(ctx.recentPrDecisions).toEqual([]);
    expect(warns.some((l) => /pr_decisions read failed/.test(l))).toBe(true);
  });

  it('reads past goal_proposals when the reader is wired', async () => {
    const now = Date.now();
    const rows: PastProposalSummary[] = [
      {
        id: 'p1',
        proposedAt: now - 86_400_000,
        source: 'learnings',
        title: 'one',
        decision: 'approved',
        resultingPrOutcome: 'merged',
      },
    ];

    const ctx = await loadProposerContext(
      'weautomatehq1/IFleet',
      makeCfg(repoRoot),
      {
        warn: () => {},
        pastProposalsByRepo: () => rows,
      },
    );

    expect(ctx.pastProposals).toEqual(rows);
  });
});
