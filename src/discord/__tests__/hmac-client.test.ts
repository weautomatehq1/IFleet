import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { ControlPlaneError, HmacControlPlaneClient, signPayload } from '../hmac-client.js';

const SECRET = 'test-secret';
const URL = 'http://127.0.0.1:3001/control';

describe('signPayload', () => {
  it('matches the server-side scheme: sha256(timestamp + "." + body)', () => {
    const ts = '1700000000';
    const body = JSON.stringify({ type: 'sprint_goal', goal: 'hi' });
    const expected = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(signPayload(SECRET, ts, body)).toBe(expected);
  });

  it('is deterministic and 64 hex chars', () => {
    const sig = signPayload(SECRET, '1', 'hello');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(sig).toBe(signPayload(SECRET, '1', 'hello'));
  });
});

describe('HmacControlPlaneClient', () => {
  it('POSTs JSON body with the two signature headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      expect(init?.method).toBe('POST');
      expect(headers.get('content-type')).toBe('application/json');
      const ts = headers.get('x-ifleet-timestamp')!;
      const sig = headers.get('x-ifleet-signature')!;
      expect(ts).toMatch(/^\d+$/);
      expect(sig).toMatch(/^[a-f0-9]{64}$/);
      const body = init?.body as string;
      expect(sig).toBe(signPayload(SECRET, ts, body));
      return new Response(JSON.stringify({ ok: true, type: 'sprint_goal' }), { status: 202 });
    });

    const client = new HmacControlPlaneClient({
      url: URL,
      secret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ack = await client.postCommand({ type: 'sprint_goal', goal: 'hello' });
    expect(ack.accepted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
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
