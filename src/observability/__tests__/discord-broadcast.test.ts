import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordOutbox } from '@wahq/orchestrator-core/observability/discord-outbox';

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
    // statusCode 200 so sendNowAsync (outbox fast path) resolves; sendNow
    // (non-outbox path) ignores statusCode, so existing tests are unaffected.
    if (typeof cb === 'function') cb({ resume: () => {}, statusCode: 200 });
    return fakeReq;
  },
}));
vi.mock('node:http', () => ({
  request: (opts: unknown, cb: unknown) => {
    mockHttpRequest(opts, cb);
    const fakeReq = makeFakeReq();
    // statusCode 200 so sendNowAsync (outbox fast path) resolves; sendNow
    // (non-outbox path) ignores statusCode, so existing tests are unaffected.
    if (typeof cb === 'function') cb({ resume: () => {}, statusCode: 200 });
    return fakeReq;
  },
}));

// Import AFTER mock declaration
const { broadcastIFleet, setDiscordOutbox, __resetBroadcastStateForTests } = await import(
  '../discord-broadcast.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1234/token';
const HTTP_WEBHOOK_URL = 'http://localhost:9999/webhook';

// All sends now go through setTimeout (even delay=0) so fake timers are
// required in every test that asserts on HTTP call counts.
beforeEach(() => {
  __resetBroadcastStateForTests();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['DISCORD_IFLEET_WEBHOOK'];
});

// ---------------------------------------------------------------------------
// No-op behavior
// ---------------------------------------------------------------------------

describe('broadcastIFleet — no-op paths', () => {
  it('is a no-op when DISCORD_IFLEET_WEBHOOK is unset', () => {
    delete process.env['DISCORD_IFLEET_WEBHOOK'];
    broadcastIFleet('hello');
    vi.runAllTimers();
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
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledOnce();
    const [opts] = mockHttpRequest.mock.calls[0] as [{ hostname: string; method: string; path: string }, unknown];
    expect(opts.hostname).toBe('discord.com');
    expect(opts.method).toBe('POST');
    expect(opts.path).toContain('/api/webhooks');
  });

  it('sends body as JSON with content field', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('task done');
    vi.advanceTimersByTime(1);
    expect(mockReqWrite).toHaveBeenCalledOnce();
    const body = JSON.parse(mockReqWrite.mock.calls[0]![0] as string) as { content: string };
    expect(body.content).toBe('task done');
  });

  it('uses http.request for http:// webhook URLs (local dev)', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = HTTP_WEBHOOK_URL;
    broadcastIFleet('local test');
    vi.advanceTimersByTime(1);
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
    vi.advanceTimersByTime(1);
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
  it('sends when no prior send in window (after timer fires)', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('first');
    expect(mockHttpRequest).toHaveBeenCalledTimes(0); // pending via setTimeout(fn, 0)
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledOnce();
  });

  it('defers the second send (setTimeout) when called within MIN_INTERVAL_MS', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;

    broadcastIFleet('first');
    // First send scheduled via setTimeout(fn, 0) — not yet fired
    expect(mockHttpRequest).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1); // fire the delay=0 callback
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    broadcastIFleet('second');
    // Second call is scheduled with delay~=MIN_INTERVAL_MS — not yet fired
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Advance time past the rate-limit window
    vi.runAllTimers();
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });

  it('sends immediately again after MIN_INTERVAL_MS has elapsed', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;

    broadcastIFleet('first');
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Advance past the 2s minimum interval
    vi.advanceTimersByTime(3000);
    __resetBroadcastStateForTests(); // reset state to simulate fresh URL slot

    broadcastIFleet('third');
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });

  it('per-URL rate limiting — different URLs do not share rate-limit state', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    broadcastIFleet('via https url');
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Reset and use HTTP URL — should send immediately (separate state slot)
    __resetBroadcastStateForTests();
    process.env['DISCORD_IFLEET_WEBHOOK'] = HTTP_WEBHOOK_URL;
    broadcastIFleet('via http url');
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Queue depth cap (AUDIT-IFleet-cd19ee4c)
// Verifies that the pendingCount cap applies uniformly to ALL sends —
// including delay=0 (immediate-path) sends that previously bypassed the cap.
// ---------------------------------------------------------------------------

describe('broadcastIFleet — queue depth cap', () => {
  it('drops messages once pendingCount reaches MAX_QUEUE_DEPTH (50)', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Queue MAX_QUEUE_DEPTH messages (50). The first has delay=0, rest deferred.
    for (let i = 0; i < 50; i++) broadcastIFleet(`msg-${i}`);

    // Nothing has fired yet — all are pending via setTimeout
    expect(mockHttpRequest).toHaveBeenCalledTimes(0);

    // 51st send hits cap (pendingCount == 50 >= 50) and is dropped
    broadcastIFleet('should-be-dropped');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('dropping message'))).toBe(true);

    // Drain the queue — only the 50 queued sends fire
    vi.runAllTimers();
    expect(mockHttpRequest).toHaveBeenCalledTimes(50);

    warnSpy.mockRestore();
  });

  it('counts delay=0 sends toward the cap — immediate path no longer bypasses it', () => {
    process.env['DISCORD_IFLEET_WEBHOOK'] = WEBHOOK_URL;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Fill cap: first message would have been an immediate send under old code.
    // Under the new unified path it still increments pendingCount.
    for (let i = 0; i < 50; i++) broadcastIFleet(`msg-${i}`);

    // Fire just the delay=0 first send — pendingCount drops back to 49
    vi.advanceTimersByTime(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // Now one slot is free — next send queues successfully (no warning)
    warnSpy.mockClear();
    broadcastIFleet('fits-in-queue');
    expect(warnSpy).not.toHaveBeenCalled();

    // Drain remaining
    vi.runAllTimers();
    expect(mockHttpRequest).toHaveBeenCalledTimes(51);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Durable outbox — credential not at rest (AUDIT-IFleet-b97d9070)
// + exactly-once delivery under concurrent fast-path + drain
// (AUDIT-IFleet-0d22c6e7)
// ---------------------------------------------------------------------------

describe('broadcastIFleet — durable outbox security + exactly-once', () => {
  // Webhook URL whose token segment is a unique, searchable secret.
  const SECRET_TOKEN = 'sUpErSecRetToken_DEADBEEF';
  const SECRET_WEBHOOK_URL = `https://discord.com/api/webhooks/9999/${SECRET_TOKEN}`;

  let db: Database.Database;
  let outbox: DiscordOutbox;

  beforeEach(() => {
    db = new Database(':memory:');
    outbox = new DiscordOutbox(db);
    setDiscordOutbox(outbox);
    process.env['DISCORD_IFLEET_WEBHOOK'] = SECRET_WEBHOOK_URL;
  });

  afterEach(() => {
    setDiscordOutbox(null);
    db.close();
  });

  it('never persists the webhook token in any outbox row body', () => {
    broadcastIFleet('credential check');

    const rows = db
      .prepare('SELECT payload FROM discord_outbox')
      .all() as Array<{ payload: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload).not.toContain(SECRET_TOKEN);
      expect(row.payload).not.toContain('discord.com');
      // Payload still carries the message content for the drain to deliver.
      expect(JSON.parse(row.payload)).toMatchObject({ content: 'credential check' });
    }
  });

  it('persists no token even on the queue-overflow (drain-owned) branch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Fill the in-memory queue to MAX_QUEUE_DEPTH (50), then one more to hit
    // the overflow branch that enqueues straight to the outbox.
    for (let i = 0; i < 51; i++) broadcastIFleet(`overflow-${i}`);

    const rows = db
      .prepare('SELECT payload FROM discord_outbox')
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload).not.toContain(SECRET_TOKEN);
    }
    vi.runAllTimers();
    warnSpy.mockRestore();
  });

  it('delivers exactly once under concurrent fast-path send + drain', async () => {
    // Count drain-path deliveries separately from fast-path HTTP deliveries.
    let drainDeliveries = 0;
    const drain = () =>
      outbox.drainOnce({
        send: async () => {
          drainDeliveries++;
        },
      });

    broadcastIFleet('exactly once');

    // The row is claimed (markSent) synchronously at enqueue time, so a drain
    // that races the still-scheduled fast-path send finds nothing pending.
    let res = await drain();
    expect(res.sent).toBe(0);
    expect(drainDeliveries).toBe(0);

    // Fire the fast-path send (the single real delivery).
    await vi.advanceTimersByTimeAsync(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);

    // A drain after a successful fast-path send still finds nothing pending.
    res = await drain();
    expect(res.sent).toBe(0);
    expect(drainDeliveries).toBe(0);

    // Total deliveries across both paths == 1.
    expect(mockHttpRequest.mock.calls.length + drainDeliveries).toBe(1);

    // Row ended in the terminal `sent` state.
    const row = db
      .prepare('SELECT state FROM discord_outbox')
      .get() as { state: string };
    expect(row.state).toBe('sent');
  });

  it('re-pends for the drain (still one net delivery) when the fast-path send fails', async () => {
    let drainDeliveries = 0;
    const drain = () =>
      outbox.drainOnce({
        send: async () => {
          drainDeliveries++;
        },
      });

    // Force the fast-path send to fail: a malformed URL makes `new URL(url)`
    // inside sendNowAsync throw, so the promise rejects → markAttemptFailed
    // re-pends the row for the drain. (The webhook is read fresh on each send,
    // so overriding the env after enqueue still drives the send path.)
    process.env['DISCORD_IFLEET_WEBHOOK'] = 'not a valid url';

    broadcastIFleet('retry path');

    // Claimed synchronously → not pending while the fast-path send is in flight.
    let pending = db
      .prepare("SELECT COUNT(*) AS n FROM discord_outbox WHERE state = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);

    // Fire the (failing) fast-path send → row transitions back to pending.
    await vi.advanceTimersByTimeAsync(1);
    pending = db
      .prepare("SELECT COUNT(*) AS n FROM discord_outbox WHERE state = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(1);

    // The drain now legitimately delivers the message exactly once.
    const res = await drain();
    expect(res.sent).toBe(1);
    expect(drainDeliveries).toBe(1);

    // A second drain finds nothing — no duplicate.
    const res2 = await drain();
    expect(res2.sent).toBe(0);
    expect(drainDeliveries).toBe(1);
  });
});
