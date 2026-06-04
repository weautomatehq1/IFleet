/**
 * Tests for server.ts verify / force_pr routing behavior.
 *
 * Covers AUDIT-IFleet-a7237489: the public control-plane (port 3001) must
 * route verify / force_pr to their registered callbacks, not silently no-op.
 * In production these callbacks throw (daemon-only guard). The dispatch is
 * fire-and-forget so HTTP always returns 202 — what matters is the callback
 * is invoked and errors are not swallowed without logging.
 */

import { describe, it, expect } from 'vitest';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  createControlPlane,
  parseCommand,
  signPayload,
} from '../queue/control-plane.js';
import type { QueueAdapter } from '../queue/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopQueue(): QueueAdapter {
  return {
    pickNext: async () => null,
    markPicked: async () => undefined,
    markCompleted: async () => undefined,
    markFailed: async () => undefined,
    markCapabilityBlocked: async () => undefined,
    postStatus: async () => undefined,
    watchForNew: () => ({ stop: () => undefined }),
  };
}

function signedHeaders(
  secret: string,
  body: string,
  opts: { ts?: number; nonce?: string } = {},
): Record<string, string> {
  const timestamp = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  return {
    'content-type': 'application/json',
    'x-ifleet-timestamp': timestamp,
    'x-ifleet-nonce': nonce,
    'x-ifleet-signature': signPayload({ timestamp, nonce, body }, secret),
  };
}

// ---------------------------------------------------------------------------
// parseCommand — verify / force_pr parsing
// ---------------------------------------------------------------------------

describe('parseCommand — verify and force_pr', () => {
  it('parses verify with taskId', () => {
    expect(parseCommand('{"type":"verify","taskId":"t-v"}')).toEqual({
      type: 'verify',
      taskId: 't-v',
    });
  });

  it('parses force_pr with taskId and reason', () => {
    expect(
      parseCommand('{"type":"force_pr","taskId":"t-f","reason":"override"}'),
    ).toEqual({ type: 'force_pr', taskId: 't-f', reason: 'override' });
  });

  it('parses force_pr without reason', () => {
    const cmd = parseCommand('{"type":"force_pr","taskId":"t-g"}');
    expect(cmd.type).toBe('force_pr');
    if (cmd.type === 'force_pr') expect(cmd.taskId).toBe('t-g');
  });

  it('rejects verify without taskId', () => {
    expect(() => parseCommand('{"type":"verify"}')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// HTTP dispatch — verify / force_pr callbacks are invoked
// ---------------------------------------------------------------------------

describe('control-plane dispatch — verify / force_pr invoke callbacks', () => {
  const SECRET = 'test-server-secret';

  it('verify command → onVerify callback is invoked with taskId', async () => {
    let verifiedId: string | undefined;
    const cp = createControlPlane({
      queue: noopQueue(),
      hmacSecret: SECRET,
      port: 0,
      onVerify: async (id) => {
        verifiedId = id;
      },
    });
    await cp.start();
    try {
      const { port } = cp.server.address() as AddressInfo;
      const body = JSON.stringify({ type: 'verify', taskId: 'T-1' });
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: signedHeaders(SECRET, body),
        body,
      });
      // Dispatch is fire-and-forget → always 202
      expect(res.status).toBe(202);
    } finally {
      await cp.stop();
    }
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      if (verifiedId !== undefined) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(verifiedId).toBe('T-1');
  });

  it('force_pr command → onForcePr callback is invoked with taskId and reason', async () => {
    let forcedId: string | undefined;
    let forcedReason: string | undefined;
    const cp = createControlPlane({
      queue: noopQueue(),
      hmacSecret: SECRET,
      port: 0,
      onForcePr: async (id, reason) => {
        forcedId = id;
        forcedReason = reason;
      },
    });
    await cp.start();
    try {
      const { port } = cp.server.address() as AddressInfo;
      const body = JSON.stringify({ type: 'force_pr', taskId: 'T-2', reason: 'override' });
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: signedHeaders(SECRET, body),
        body,
      });
      expect(res.status).toBe(202);
    } finally {
      await cp.stop();
    }
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      if (forcedId !== undefined) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(forcedId).toBe('T-2');
    expect(forcedReason).toBe('override');
  });

  it('dispatch layer surfaces onVerify callback throw as 500 and server stays alive', async () => {
    // operator commands now await dispatch; a throwing handler returns 500 (not 202).
    // The server must survive the throw (healthz still 200 after).
    let threw = false;
    const cp = createControlPlane({
      queue: noopQueue(),
      hmacSecret: SECRET,
      port: 0,
      onVerify: async (taskId) => {
        threw = true;
        throw new Error(`[control-plane] verify(${taskId}) is daemon-only`);
      },
    });
    await cp.start();
    try {
      const { port } = cp.server.address() as AddressInfo;
      const body = JSON.stringify({ type: 'verify', taskId: 'T-3' });
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: signedHeaders(SECRET, body),
        body,
      });
      // Handler threw → 500 (error surfaced to caller, not silently dropped)
      expect(res.status).toBe(500);
      // Server is still alive after the throw
      const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(healthz.status).toBe(200);
    } finally {
      await cp.stop();
    }
    expect(threw).toBe(true);
  });

  it('dispatch layer surfaces onForcePr callback throw as 500 and server stays alive', async () => {
    let threw = false;
    const cp = createControlPlane({
      queue: noopQueue(),
      hmacSecret: SECRET,
      port: 0,
      onForcePr: async (taskId) => {
        threw = true;
        throw new Error(`[control-plane] force_pr(${taskId}) is daemon-only`);
      },
    });
    await cp.start();
    try {
      const { port } = cp.server.address() as AddressInfo;
      const body = JSON.stringify({ type: 'force_pr', taskId: 'T-4' });
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: signedHeaders(SECRET, body),
        body,
      });
      // Handler threw → 500 (error surfaced to caller, not silently dropped)
      expect(res.status).toBe(500);
      const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(healthz.status).toBe(200);
    } finally {
      await cp.stop();
    }
    expect(threw).toBe(true);
  });
});
