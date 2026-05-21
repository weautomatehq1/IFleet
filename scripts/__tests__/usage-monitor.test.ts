import { describe, it, expect, vi } from 'vitest';
import { analyzeBlocks, buildAlertMessage, type CcusageBlock, type CcusageOutput } from '../usage-monitor.js';

// ---- fixtures --------------------------------------------------------------

function makeBlock(
  overrides: Partial<CcusageBlock> & { hoursAgo: number },
): CcusageBlock {
  const { hoursAgo, ...rest } = overrides;
  const start = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 5 * 60 * 60 * 1000);
  return {
    id: start.toISOString(),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    actualEndTime: end.toISOString(),
    isActive: false,
    isGap: false,
    entries: 500,
    costUSD: 10,
    totalTokens: 1_000_000,
    burnRate: null,
    projection: null,
    tokenCounts: {
      inputTokens: 10000,
      outputTokens: 5000,
      cacheCreationInputTokens: 50000,
      cacheReadInputTokens: 935000,
    },
    models: ['claude-sonnet-4-6'],
    ...rest,
  };
}

function makeOutput(blocks: CcusageBlock[]): CcusageOutput {
  return { blocks };
}

const OPTS = { blockCap: 1000, weeklyCap: 10000, alertThreshold: 0.8, now: new Date() };

// ---- analyzeBlocks ---------------------------------------------------------

describe('analyzeBlocks', () => {
  it('returns zero entries when no blocks exist', () => {
    const result = analyzeBlocks(makeOutput([]), OPTS);
    expect(result.last7DaysEntries).toBe(0);
    expect(result.weeklyCapPct).toBe(0);
    expect(result.alertFired).toBe(false);
  });

  it('sums entries from last 7 days only', () => {
    const blocks = [
      makeBlock({ hoursAgo: 10, entries: 200 }),
      makeBlock({ hoursAgo: 100, entries: 300 }),
      makeBlock({ hoursAgo: 200, entries: 999, id: 'old-block-200h' }),
    ];
    // Only first two are within 7 days (168h); third is 200h ago
    const result = analyzeBlocks(makeOutput(blocks), { ...OPTS, now: new Date() });
    expect(result.last7DaysEntries).toBe(200 + 300);
  });

  it('skips gap blocks', () => {
    const blocks = [
      makeBlock({ hoursAgo: 10, entries: 200 }),
      makeBlock({ hoursAgo: 20, entries: 999, isGap: true }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.last7DaysEntries).toBe(200);
  });

  it('fires alert when weekly usage exceeds threshold', () => {
    const blocks = [
      makeBlock({ hoursAgo: 5, entries: 8500 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.alertFired).toBe(true);
    expect(result.alertReason).toContain('weekly');
    expect(result.weeklyCapPct).toBeCloseTo(0.85);
  });

  it('does NOT fire alert when usage is below threshold', () => {
    const blocks = [
      makeBlock({ hoursAgo: 5, entries: 500 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.alertFired).toBe(false);
    expect(result.weeklyCapPct).toBeCloseTo(0.05);
  });

  it('fires alert when active block projected entries exceed threshold', () => {
    const blocks = [
      makeBlock({ hoursAgo: 2, isActive: true, entries: 700, projection: 900 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.alertFired).toBe(true);
    expect(result.alertReason).toContain('active block');
    expect(result.activeBlockCapPct).toBeCloseTo(0.9);
  });

  it('uses projection over entries for active block cap pct', () => {
    const blocks = [
      makeBlock({ hoursAgo: 1, isActive: true, entries: 200, projection: 850 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.activeBlockCapPct).toBeCloseTo(0.85);
    expect(result.alertFired).toBe(true);
  });

  it('falls back to entries when projection is null for active block', () => {
    const blocks = [
      makeBlock({ hoursAgo: 1, isActive: true, entries: 600, projection: null }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    // 600/1000 = 0.6 < 0.8 threshold
    expect(result.activeBlockCapPct).toBeCloseTo(0.6);
    expect(result.alertFired).toBe(false);
  });

  it('identifies the active block', () => {
    const blocks = [
      makeBlock({ hoursAgo: 10, isActive: false, entries: 100 }),
      makeBlock({ hoursAgo: 2, isActive: true, entries: 300 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.activeBlock).not.toBeNull();
    expect(result.activeBlock?.entries).toBe(300);
  });

  it('returns null activeBlock when no block is active', () => {
    const blocks = [makeBlock({ hoursAgo: 10, isActive: false })];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.activeBlock).toBeNull();
  });

  it('accumulates cost correctly', () => {
    const blocks = [
      makeBlock({ hoursAgo: 5, entries: 100, costUSD: 5 }),
      makeBlock({ hoursAgo: 10, entries: 100, costUSD: 7.5 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    expect(result.last7DaysCostUSD).toBeCloseTo(12.5);
  });
});

// ---- buildAlertMessage -----------------------------------------------------

describe('buildAlertMessage', () => {
  it('includes weekly and block alert details', () => {
    const blocks = [
      makeBlock({ hoursAgo: 1, isActive: true, entries: 900, projection: 950, burnRate: 3.5 }),
      makeBlock({ hoursAgo: 10, entries: 8800 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    const msg = buildAlertMessage(result);
    expect(msg).toContain('[IFleet]');
    expect(msg).toContain('burn-rate alert');
    expect(msg).toContain('entries');
    expect(msg).toContain('%');
  });

  it('includes burn rate when available', () => {
    const blocks = [
      makeBlock({ hoursAgo: 1, isActive: true, entries: 900, burnRate: 4.2, projection: 900 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    const msg = buildAlertMessage(result);
    expect(msg).toContain('4.2');
  });

  it('omits burn rate line when burnRate is null', () => {
    const blocks = [
      makeBlock({ hoursAgo: 1, isActive: true, entries: 900, burnRate: null, projection: 900 }),
    ];
    const result = analyzeBlocks(makeOutput(blocks), OPTS);
    const msg = buildAlertMessage(result);
    expect(msg).not.toContain('entries/min');
  });
});

// ---- Discord payload shape -------------------------------------------------

describe('postToDiscord payload shape', () => {
  it('constructs expected Discord REST URL', async () => {
    const captured: RequestInit[] = [];
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      captured.push(init);
      return new Response(JSON.stringify({ id: '123' }), { status: 200 });
    });

    vi.stubGlobal('fetch', mockFetch);
    const { postToDiscord } = await import('../usage-monitor.js');
    await postToDiscord('TEST_CHANNEL', 'BOT_TOKEN', 'hello alert');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://discord.com/api/v10/channels/TEST_CHANNEL/messages');
    expect(calledInit.method).toBe('POST');
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe('Bot BOT_TOKEN');
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.content).toBe('hello alert');
    vi.unstubAllGlobals();
  });

  it('skips post when token is empty', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const { postToDiscord } = await import('../usage-monitor.js');
    await postToDiscord('CH', '', 'msg');
    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
