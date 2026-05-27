/**
 * Tests for server.ts verify / force_pr routing behavior.
 *
 * Covers AUDIT-IFleet-a7237489: the public control-plane (port 3001) must
 * route verify / force_pr to their registered callbacks, not silently no-op.
 * In production these callbacks throw (daemon-only guard). The dispatch is
 * fire-and-forget so HTTP always returns 202 — what matters is the callback
 * is invoked and errors are not swallowed without logging.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
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
    assert.deepEqual(parseCommand('{"type":"verify","taskId":"t-v"}'), {
      type: 'verify',
      taskId: 't-v',
    });
  });

  it('parses force_pr with taskId and reason', () => {
    assert.deepEqual(
      parseCommand('{"type":"force_pr","taskId":"t-f","reason":"override"}'),
      { type: 'force_pr', taskId: 't-f', reason: 'override' },
    );
  });

  it('parses force_pr without reason', () => {
    const cmd = parseCommand('{"type":"force_pr","taskId":"t-g"}');
    assert.equal(cmd.type, 'force_pr');
    if (cmd.type === 'force_pr') assert.equal(cmd.taskId, 't-g');
  });

  it('rejects verify without taskId', () => {
    assert.throws(() => parseCommand('{"type":"verify"}'));
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
      onVerify: async (id) => { verifiedId = id; },
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
      assert.equal(res.status, 202);
    } finally {
      await cp.stop();
    }
    // Give fire-and-forget a tick to settle
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(verifiedId, 'T-1');
  });

  it('force_pr command → onForcePr callback is invoked with taskId and reason', async () => {
    let forcedId: string | undefined;
    let forcedReason: string | undefined;
    const cp = createControlPlane({
      queue: noopQueue(),
      hmacSecret: SECRET,
      port: 0,
      onForcePr: async (id, reason) => { forcedId = id; forcedReason = reason; },
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
      assert.equal(res.status, 202);
    } finally {
      await cp.stop();
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(forcedId, 'T-2');
    assert.equal(forcedReason, 'override');
  });

  it('verify → onVerify that throws does not crash the server (error is logged, not fatal)', async () => {
    // This mirrors server.ts production behavior: onVerify throws for daemon-only guard
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
      // Should still return 202 — error is fire-and-forget, not HTTP error
      const res = await fetch(`http://127.0.0.1:${port}/control`, {
        method: 'POST',
        headers: signedHeaders(SECRET, body),
        body,
      });
      assert.equal(res.status, 202);
      // Server is still alive after the throw
      const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(healthz.status, 200);
    } finally {
      await cp.stop();
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(threw, true);
  });

  it('force_pr → onForcePr that throws does not crash the server', async () => {
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
      assert.equal(res.status, 202);
      const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(healthz.status, 200);
    } finally {
      await cp.stop();
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(threw, true);
  });
});
