import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock — intercept node:https and node:http requests at the module
// level so the actual HTTP calls never fire in tests.
// ---------------------------------------------------------------------------
const mockHttpRequest = vi.fn();
const mockReqWrite = vi.fn();
const mockReqEnd = vi.fn();
const mockReqOn = vi.fn();

function makeFakeReq(): { write: typeof mockReqWrite; end: typeof mockReqEnd; on: typeof mockReqOn } {
  return { write: mockReqWrite, end: mockReqEnd, on: mockReqOn };
}

vi.mock('node:https', () => ({
  request: (opts: unknown, cb: unknown) => {
    mockHttpRequest(opts, cb);
    const fakeReq = makeFakeReq();
    // Call the response callback with a fake res that has .resume()
    if (typeof cb === 'function') cb({ resume: () => {} });
    return fakeReq;
  },
}));
vi.mock('node:http', () => ({
  request: (opts: unknown, cb: unknown) => {
    mockHttpRequest(opts, cb);
    const fakeReq = makeFakeReq();
    if (typeof cb === 'function') cb({ resume: () => {} });
    return fakeReq;
  },
}));

// Import AFTER mock declaration
const { broadcastIFleet, __resetBroadcastStateForTests } = await import('../discord-broadcast.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1234/token';
const HTTP_WEBHOOK_URL = 'http://localhost:9999/webhook';

beforeEach(() => {
  __resetBroadcastStateForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env['DISCORD_IFLEET_WEBHOOK'];
});

// ---------------------------------------------------------------------------
// No-op behavior
// ---------------------------------------------------------------------------

describe('broadcastIFleet — no-op paths', () => {
  it('is a no-op when DISCORD_IFLEET_WEBHOOK is unset', () => {
    delete process.env['DISCORD_IFLEET_WEBHOOK'];
    broadcastIFleet('hello');
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it('warns once to stderr when env var is unset, then stays silent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env['DISCORD_IFLEET_WEBHOOK'];
    broadcastIFleet('a');
    broadcastIFleet('b');
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('DISCORD_IFLEET_WEBHOOK'))).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

describe('broadcastIFleet — HTTP wiring', () => {
  it('fires an HTTPS request to the webhook URL', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('hello');
    expect(mockHttpRequest).toHaveBeenCalledOnce();
    const [opts] = mockHttpRequest.mock.calls[0] as [{ hostname: string; method: string; path: string }, unknown];
    expect(opts.hostname).toBe('discord.com');
    expect(opts.method).toBe('POST');
    expect(opts.path).toContain('/api/webhooks');
  });

  it('sends body as JSON with content field', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('task done');
    expect(mockReqWrite).toHaveBeenCalledOnce();
    const body = JSON.parse(mockReqWrite.mock.calls[0]![0] as string) as { content: string };
    expect(body.content).toBe('task done');
  });

  it('uses http.request for http:// webhook URLs (local dev)', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = HTTP_WEBHOOK_URL;
    broadcastIFleet('local test');
    expect(mockHttpRequest).toHaveBeenCalledOnce();
    const [opts] = mockHttpRequest.mock.calls[0] as [{ hostname: string; port: string }, unknown];
    expect(opts.hostname).toBe('localhost');
    expect(opts.port).toBe('9999');
  });

  it('does not throw when webhook URL is malformed', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = 'not a real url';
    expect(() => broadcastIFleet('hello')).not.toThrow();
  });

  it('truncates messages over 1900 chars', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    const huge = 'x'.repeat(2500);
    broadcastIFleet(huge);
    expect(mockReqWrite).toHaveBeenCalledOnce();
    const body = JSON.parse(mockReqWrite.mock.calls[0]![0] as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(1900);
    expect(body.content.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter (AUDIT-IFleet-2e7a838d / AUDIT-IFleet-7912f2d9)
// ---------------------------------------------------------------------------

describe('broadcastIFleet — rate limiter', () => {
  it('sends immediately when no prior send in window', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('first');
    expect(mockHttpRequest).toHaveBeenCalledOnce();
  });

  it('defers the second send (setTimeout) when called within MIN_INTERVAL_MS', () => {
    vi.useFakeTimers();
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;

    broadcastIFleet('first');
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    broadcastIFleet('second');
    // Second call is scheduled, not yet fired
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Advance time past the rate-limit window
    vi.runAllTimers();
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('sends immediately again after MIN_INTERVAL_MS has elapsed', () => {
    vi.useFakeTimers();
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;

    broadcastIFleet('first');
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Advance past the 2s minimum interval
    vi.advanceTimersByTime(3000);
    __resetBroadcastStateForTests(); // reset state to simulate fresh URL slot

    broadcastIFleet('third');
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('per-URL rate limiting — different URLs do not share rate-limit state', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('via https url');
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Reset and use HTTP URL — should send immediately (separate state slot)
    __resetBroadcastStateForTests();
    process.env['DISCORD_IFLEET_WEBHOOK'] = HTTP_WEBHOOK_URL;
    broadcastIFleet('via http url');
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });
});

describe('broadcastIFleet — queue depth cap', () => {
  it('drops messages when queue depth exceeds cap', () => {
    vi.useFakeTimers();
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;

    // Capture console.warn calls to verify drop messages
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Send 55 messages — first will send immediately, remaining 54 will queue
    // but only 49 can queue (50 total pending including first), so last 5 drop
    for (let i = 0; i < 55; i++) {
      broadcastIFleet(`message ${i}`);
    }

    // First message sends immediately (delay=0)
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    // Messages 2-50 are queued (delay>0, pendingCount < 50)
    // Messages 51-55 should be dropped with warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/queue depth.*>=.*dropping message/),
    );

    // Advance timers to drain the queue
    vi.runAllTimers();

    // After draining, all 50 queued messages should have sent
    expect(mockHttpRequest).toHaveBeenCalledTimes(51);

    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});
