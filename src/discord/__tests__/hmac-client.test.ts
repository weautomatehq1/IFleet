import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { ControlPlaneError, HmacControlPlaneClient, signPayload } from '@wahq/orchestrator-core/discord/hmac-client';

const SECRET = 'test-secret';
const URL = 'http://127.0.0.1:3001/control';

describe('signPayload', () => {
  it('matches the server-side scheme: sha256(timestamp + "." + nonce + "." + body)', () => {
    const ts = '1700000000';
    const nonce = 'nonce-deadbeef';
    const body = JSON.stringify({ type: 'sprint_goal', goal: 'hi' });
    const expected = createHmac('sha256', SECRET)
      .update(`${ts}.${nonce}.${body}`)
      .digest('hex');
    expect(signPayload({ timestamp: ts, nonce, body }, SECRET)).toBe(expected);
  });

  it('is deterministic and 64 hex chars', () => {
    const sig = signPayload({ timestamp: '1', nonce: 'n1', body: 'hello' }, SECRET);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(sig).toBe(signPayload({ timestamp: '1', nonce: 'n1', body: 'hello' }, SECRET));
  });

  it('changes with the nonce — captured signature is not replayable under a new nonce', () => {
    const ts = '1700000000';
    const body = JSON.stringify({ type: 'cancel', taskId: 't1' });
    const sigA = signPayload({ timestamp: ts, nonce: 'first', body }, SECRET);
    const sigB = signPayload({ timestamp: ts, nonce: 'second', body }, SECRET);
    expect(sigA).not.toBe(sigB);
  });
});

describe('HmacControlPlaneClient', () => {
  it('POSTs JSON body with timestamp + nonce + signature headers', async () => {
    const seenNonces: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      expect(init?.method).toBe('POST');
      expect(headers.get('content-type')).toBe('application/json');
      const ts = headers.get('x-ifleet-timestamp')!;
      const nonce = headers.get('x-ifleet-nonce')!;
      const sig = headers.get('x-ifleet-signature')!;
      expect(ts).toMatch(/^\d+$/);
      expect(nonce.length).toBeGreaterThanOrEqual(8);
      expect(nonce.length).toBeLessThanOrEqual(64);
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
      const body = init?.body as string;
      expect(sig).toBe(signPayload({ timestamp: ts, nonce, body }, SECRET));
      seenNonces.push(nonce);
      return new Response(JSON.stringify({ ok: true, type: 'sprint_goal' }), { status: 202 });
    });

    const client = new HmacControlPlaneClient({
      url: URL,
      secret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.postCommand({ type: 'sprint_goal', goal: 'hello' });
    await client.postCommand({ type: 'sprint_goal', goal: 'world' });
    expect(seenNonces).toHaveLength(2);
    expect(new Set(seenNonces).size).toBe(2);
  });

  it('throws ControlPlaneError on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad signature', { status: 401 }),
    ) as unknown as typeof fetch;
    const client = new HmacControlPlaneClient({ url: URL, secret: SECRET, fetchImpl });
    await expect(client.postCommand({ type: 'status', taskId: 't1' })).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
  });

  it('returns ack=true even for empty body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch;
    const client = new HmacControlPlaneClient({ url: URL, secret: SECRET, fetchImpl });
    const ack = await client.postCommand({ type: 'run' });
    expect(ack.accepted).toBe(true);
  });

  it('requires url + secret', () => {
    expect(
      () => new HmacControlPlaneClient({ url: '', secret: SECRET }),
    ).toThrow(/url is required/);
    expect(
      () => new HmacControlPlaneClient({ url: URL, secret: '' }),
    ).toThrow(/secret is required/);
  });
});
