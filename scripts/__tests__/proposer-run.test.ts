// Tests for the proposer cron wiring (scripts/proposer-run.ts).
//
// Covers two regressions:
//   - AUDIT-IFleet-2057d021 / AUDIT-IFleet-8dd8e04c: the cron must boot its
//     own discord.js Client and call registerProposerDiscordClient BEFORE
//     runProposer fires (the daemon's call doesn't cross PM2 processes).
//   - AUDIT-IFleet-322a2854: buildContextDeps must wire both
//     prDecisionsByRepo and pastProposalsByRepo so the context-loader doesn't
//     silently fall back to empty arrays and disable past-title dedupe / the
//     Voyager loop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loginSpy = vi.fn(async (_token: string) => 'logged-in');
const destroySpy = vi.fn(async () => undefined);
const clientCtorSpy = vi.fn();

vi.mock('discord.js', () => {
  class MockClient {
    public login = loginSpy;
    public destroy = destroySpy;
    constructor(opts: unknown) {
      clientCtorSpy(opts);
    }
  }
  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
    },
  };
});

const registerSpy = vi.fn();
vi.mock('../../src/agents/proposer/approval-gate.js', () => ({
  registerProposerDiscordClient: registerSpy,
}));

const getPastSpy = vi.fn(async (_repoId: string, _limit: number) => []);
vi.mock('../../src/orchestrator/goal-proposals-store.js', () => ({
  getPastProposalsByRepo: getPastSpy,
}));

// Imported AFTER the mocks above so the script binds to the mocked symbols.
const { bootDiscordClient, buildContextDeps } = await import('../proposer-run.js');

beforeEach(() => {
  loginSpy.mockClear();
  destroySpy.mockClear();
  clientCtorSpy.mockClear();
  registerSpy.mockClear();
  getPastSpy.mockClear();
});

describe('bootDiscordClient (AUDIT-IFleet-2057d021 / 8dd8e04c)', () => {
  it('returns null and never registers when DISCORD_BOT_TOKEN is unset', async () => {
    const result = await bootDiscordClient(undefined);
    expect(result).toBeNull();
    expect(clientCtorSpy).not.toHaveBeenCalled();
    expect(loginSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('returns null on empty-string token (operator forgot to set it)', async () => {
    const result = await bootDiscordClient('');
    expect(result).toBeNull();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('boots a client with minimal intents, logs in, registers on the seam', async () => {
    const result = await bootDiscordClient('bot-token-xyz');
    expect(result).not.toBeNull();
    expect(clientCtorSpy).toHaveBeenCalledTimes(1);
    const ctorArg = clientCtorSpy.mock.calls[0]![0] as { intents: number[] };
    // Cron only POSTS — it does not need MessageContent or reaction intents.
    expect(ctorArg.intents).toEqual([1, 2]);
    expect(loginSpy).toHaveBeenCalledWith('bot-token-xyz');
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy.mock.calls[0]![0]).toBe(result);
  });

  it('registers the client AFTER login completes (order matters for race-free posts)', async () => {
    await bootDiscordClient('bot-token-xyz');
    const loginOrder = loginSpy.mock.invocationCallOrder[0]!;
    const registerOrder = registerSpy.mock.invocationCallOrder[0]!;
    expect(registerOrder).toBeGreaterThan(loginOrder);
  });
});

describe('buildContextDeps (AUDIT-IFleet-322a2854)', () => {
  it('wires prDecisionsByRepo through to TaskStore.getPrDecisionsByRepo with the supplied limit', async () => {
    const calls: Array<{ repo: string; limit: number }> = [];
    const fakeStore = {
      getPrDecisionsByRepo(repo: string, limit: number) {
        calls.push({ repo, limit });
        return [];
      },
    };
    const deps = buildContextDeps(fakeStore);
    expect(deps.prDecisionsByRepo).toBeDefined();
    await deps.prDecisionsByRepo!('weautomatehq1/IFleet', 500);
    expect(calls).toEqual([{ repo: 'weautomatehq1/IFleet', limit: 500 }]);
  });

  it('wires pastProposalsByRepo through to getPastProposalsByRepo with the supplied limit', async () => {
    const fakeStore = { getPrDecisionsByRepo: () => [] };
    const deps = buildContextDeps(fakeStore);
    expect(deps.pastProposalsByRepo).toBeDefined();
    await deps.pastProposalsByRepo!('weautomatehq1/IFleet', 500);
    expect(getPastSpy).toHaveBeenCalledWith('weautomatehq1/IFleet', 500);
  });

  it('returns deps with BOTH reader seams defined (the omission is the bug)', () => {
    const deps = buildContextDeps({ getPrDecisionsByRepo: () => [] });
    // The actual regression: prior code returned `undefined` for both because
    // it never built a deps object at all. Guard explicitly.
    expect(typeof deps.prDecisionsByRepo).toBe('function');
    expect(typeof deps.pastProposalsByRepo).toBe('function');
  });
});

describe('integration shape: registration flips the approval-gate branch', () => {
  // Use the REAL approval-gate here (not the mocked spy) to verify the
  // observable behaviour the audit findings describe.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('without registration, postProposalsForApproval logs "no Discord client" and returns 0', async () => {
    vi.doUnmock('../../src/agents/proposer/approval-gate.js');
    const gate = await import('../../src/agents/proposer/approval-gate.js');
    gate._resetProposerDiscordClient();

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const n = await gate.postProposalsForApproval([], { repoId: 'r' } as never);
      expect(n).toBe(0);
      expect(warns.some((w) => /no Discord client registered/.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('after registration, postProposalsForApproval does NOT take the "no client" branch', async () => {
    vi.doUnmock('../../src/agents/proposer/approval-gate.js');
    const gate = await import('../../src/agents/proposer/approval-gate.js');
    gate._resetProposerDiscordClient();

    // discord.js Client surface the gate touches: channels.fetch. With 0
    // candidates the impl returns 0 before fetching, but reaching the impl at
    // all proves the cachedClient branch was taken.
    const fakeClient = {
      channels: { fetch: async () => null },
    } as unknown as Parameters<typeof gate.registerProposerDiscordClient>[0];
    gate.registerProposerDiscordClient(fakeClient);

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const n = await gate.postProposalsForApproval([], { repoId: 'r' } as never);
      expect(n).toBe(0);
      expect(warns.some((w) => /no Discord client registered/.test(w))).toBe(false);
    } finally {
      console.warn = origWarn;
      gate._resetProposerDiscordClient();
    }
  });
});
