import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getProposalsChannelId,
  postProposalsForApproval,
  type DiscordPostDeps,
} from '../proposals.js';
import type { DedupedCandidate, ProposerConfig } from '../../agents/proposer/types.js';

const insertedRows: Array<{ id: string; repo_id: string; title: string }> = [];

vi.mock('../../orchestrator/goal-proposals-store.ts', () => ({
  insertProposal: vi.fn(async (input: { id: string; repo_id: string; title: string }) => {
    insertedRows.push(input);
  }),
}));

const cfg: ProposerConfig = {
  repoId: 'weautomatehq1/IFleet',
  repoRoot: '/tmp/IFleet',
  budget: 3,
  hardMax: 10,
  windowDays: 7,
  pastProposalsWindowDays: 30,
  embeddingModel: 'voyage-3',
  dedupThreshold: 0.85,
  discordChannelId: 'CHAN_TEST',
};

function makeCandidate(overrides: Partial<DedupedCandidate> = {}): DedupedCandidate {
  return {
    title: 'Add audit reopen sweep',
    rationale: 'Reopened findings have no GC; storage grows monotonically.',
    estimated_value: 0.7,
    estimated_difficulty: 0.4,
    source: 'sprint_gap',
    sprint_alignment: 0.6,
    composite_score: 0.65,
    nearest_neighbor_sim: 0.1,
    dropped: false,
    ...overrides,
  };
}

interface FakeChannel {
  send: ReturnType<typeof vi.fn>;
}

function makeDeps(channel: FakeChannel | null, idSeq: string[] = []): DiscordPostDeps {
  let i = 0;
  return {
    fetchChannel: vi.fn(async () => (channel as unknown as null) ?? null),
    generateId: () => idSeq[i++] ?? `gen-${i}`,
    warn: vi.fn(),
  };
}

beforeEach(() => {
  insertedRows.length = 0;
  delete process.env['IFLEET_PROPOSALS_CHANNEL_ID'];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getProposalsChannelId', () => {
  it('prefers cfg.discordChannelId', () => {
    expect(getProposalsChannelId(cfg)).toBe('CHAN_TEST');
  });

  it('falls back to env var', () => {
    process.env['IFLEET_PROPOSALS_CHANNEL_ID'] = 'CHAN_ENV';
    const cfgNoChannel = { ...cfg, discordChannelId: undefined };
    expect(getProposalsChannelId(cfgNoChannel)).toBe('CHAN_ENV');
  });

  it('returns null when neither is set', () => {
    const cfgNoChannel = { ...cfg, discordChannelId: undefined };
    expect(getProposalsChannelId(cfgNoChannel)).toBeNull();
  });
});

describe('postProposalsForApproval', () => {
  it('inserts a row and posts a message per non-dropped candidate', async () => {
    const channel: FakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) };
    const candidates = [makeCandidate(), makeCandidate({ title: 'Second' })];
    const deps = makeDeps(channel, ['id-a', 'id-b']);

    const posted = await postProposalsForApproval(candidates, cfg, deps);

    expect(posted).toBe(2);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]!.id).toBe('id-a');
    expect(insertedRows[1]!.id).toBe('id-b');
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('attaches three buttons (approve/reject/defer) with the proposal id as customId suffix', async () => {
    const channel: FakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) };
    const deps = makeDeps(channel, ['the-id']);
    await postProposalsForApproval([makeCandidate()], cfg, deps);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = channel.send.mock.calls[0]![0] as {
      content: string;
      components: Array<{ components: Array<{ data: { custom_id: string; label: string } }> }>;
    };
    expect(payload.content).toMatch(/Add audit reopen sweep/);
    expect(payload.components).toHaveLength(1);
    const row = payload.components[0]!;
    expect(row.components).toHaveLength(3);
    const customIds = row.components.map((b) => b.data.custom_id);
    expect(customIds).toEqual([
      'proposal_approve:the-id',
      'proposal_reject:the-id',
      'proposal_defer:the-id',
    ]);
  });

  it('skips candidates marked dropped', async () => {
    const channel: FakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) };
    const candidates = [
      makeCandidate({ dropped: true, reason: 'duplicate' }),
      makeCandidate({ title: 'Live one' }),
    ];
    const deps = makeDeps(channel, ['only-id']);

    const posted = await postProposalsForApproval(candidates, cfg, deps);

    expect(posted).toBe(1);
    expect(insertedRows).toHaveLength(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('returns 0 and skips all writes when dryRun=true', async () => {
    const channel: FakeChannel = { send: vi.fn() };
    const deps = makeDeps(channel);
    const posted = await postProposalsForApproval([makeCandidate()], { ...cfg, dryRun: true }, deps);

    expect(posted).toBe(0);
    expect(insertedRows).toHaveLength(0);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('returns 0 when no channel id is resolvable', async () => {
    const channel: FakeChannel = { send: vi.fn() };
    const deps = makeDeps(channel);
    const cfgNoChannel = { ...cfg, discordChannelId: undefined };
    const posted = await postProposalsForApproval([makeCandidate()], cfgNoChannel, deps);

    expect(posted).toBe(0);
    expect(insertedRows).toHaveLength(0);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('returns 0 when channel fetch yields null', async () => {
    const deps = makeDeps(null);
    const posted = await postProposalsForApproval([makeCandidate()], cfg, deps);
    expect(posted).toBe(0);
    expect(insertedRows).toHaveLength(0);
  });
});
