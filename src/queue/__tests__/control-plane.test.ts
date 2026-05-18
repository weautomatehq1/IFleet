import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import {
  createControlPlane,
  parseCommand,
  signPayload,
  verifySignature,
} from '../control-plane.js';
import type { QueueAdapter, QueuedTask } from '../types.js';

const fixedNonce = (): string => randomUUID();

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

describe('verifySignature (nonce-included payload)', () => {
  it('round-trips a known signature', () => {
    const secret = 'shh';
    const body = '{"type":"run"}';
    const ts = '1700000000';
    const nonce = 'nonce-1234567890';
    const sig = signPayload({ timestamp: ts, nonce, body }, secret);
    assert.ok(verifySignature(secret, ts, nonce, body, sig));
  });

  it('rejects modified bodies', () => {
    const sig = signPayload({ timestamp: '1', nonce: 'n', body: '{}' }, 'shh');
    assert.equal(verifySignature('shh', '1', 'n', '{"x":1}', sig), false);
  });

  it('rejects wrong secret', () => {
    const sig = signPayload({ timestamp: '1', nonce: 'n', body: '{}' }, 'shh');
    assert.equal(verifySignature('other', '1', 'n', '{}', sig), false);
  });

  it('rejects when the nonce in the header differs from the one that was signed', () => {
    const sig = signPayload({ timestamp: '1', nonce: 'first', body: '{}' }, 'shh');
    assert.equal(verifySignature('shh', '1', 'second', '{}', sig), false);
  });

  it('rejects length-mismatched signatures (timing-safe compare safe)', () => {
    assert.equal(verifySignature('shh', '1', 'n', '{}', 'ab'), false);
    assert.equal(verifySignature('shh', '1', 'n', '{}', ''), false);
  });
});

describe('parseCommand', () => {
  it('parses sprint_goal', () => {
    const cmd = parseCommand('{"type":"sprint_goal","goal":"ship X"}');
    assert.deepEqual(cmd, { type: 'sprint_goal', goal: 'ship X' });
  });

  it('parses sprint_goal with repo', () => {
    const cmd = parseCommand('{"type":"sprint_goal","goal":"X","repo":"a/b"}');
    assert.deepEqual(cmd, { type: 'sprint_goal', goal: 'X', repo: 'a/b' });
  });

  it('parses run', () => {
    assert.deepEqual(parseCommand('{"type":"run"}'), { type: 'run' });
  });

  it('parses cancel with reason', () => {
    assert.deepEqual(parseCommand('{"type":"cancel","taskId":"t1","reason":"x"}'), {
      type: 'cancel',
      taskId: 't1',
      reason: 'x',
    });
  });

  it('rejects sprint_goal with empty goal', () => {
    assert.throws(() => parseCommand('{"type":"sprint_goal","goal":""}'));
  });

  it('parses approve', () => {
    assert.deepEqual(parseCommand('{"type":"approve","taskId":"t-1"}'), {
      type: 'approve',
      taskId: 't-1',
    });
  });

  it('parses sprint_goal with discord-source extras', () => {
    const cmd = parseCommand(
      JSON.stringify({
        type: 'sprint_goal',
        goal: 'X',
        channelId: 'c',
        messageId: 'm',
        userId: 'u',
        userLabel: 'Esmel',
        idempotencyKey: 'k',
        planOnly: true,
      }),
    );
    assert.deepEqual(cmd, {
      type: 'sprint_goal',
      goal: 'X',
      channelId: 'c',
      messageId: 'm',
      userId: 'u',
      userLabel: 'Esmel',
      idempotencyKey: 'k',
      planOnly: true,
    });
  });

  it('rejects unknown type', () => {
    assert.throws(() => parseCommand('{"type":"nuke"}'));
  });

  it('rejects non-object body', () => {
    assert.throws(() => parseCommand('"hello"'));
  });
});

describe('control plane HTTP', () => {
  async function withServer<T>(
    secret: string,
    handler: {
      onRun?: () => void;
      onSprintGoal?: (cmd: { goal: string }) => void | { taskId?: string };
      onApprove?: (taskId: string) => void;
      onCancel?: (taskId: string, reason?: string) => void;
      resolveTask?: () => QueuedTask | null;
    },
    fn: (url: string) => Promise<T>,
  ): Promise<T> {
    const queue = noopQueue();
    const cp = createControlPlane({
      queue,
      hmacSecret: secret,
      port: 0,
      ...handler,
    });
    await cp.start();
    const addr = cp.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/control`;
    try {
      return await fn(url);
    } finally {
      await cp.stop();
    }
  }

  function signedHeaders(
    secret: string,
    body: string,
    opts: { ts?: number; nonce?: string } = {},
  ): Record<string, string> {
    const timestamp = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const nonce = opts.nonce ?? fixedNonce();
    return {
      'content-type': 'application/json',
      'x-ifleet-timestamp': timestamp,
      'x-ifleet-nonce': nonce,
      'x-ifleet-signature': signPayload({ timestamp, nonce, body }, secret),
    };
  }

  it('accepts a valid signed run command', async () => {
    let ran = false;
    await withServer('s', { onRun: () => (ran = true) }, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
    });
    assert.equal(ran, true);
  });

  it('rejects bad signature', async () => {
    await withServer('s', {}, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const headers = signedHeaders('s', body);
      headers['x-ifleet-signature'] = 'deadbeef'.padEnd(64, '0');
      const res = await fetch(url, { method: 'POST', headers, body });
      assert.equal(res.status, 401);
    });
  });

  it('rejects stale timestamp', async () => {
    await withServer('s', {}, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const old = Math.floor(Date.now() / 1000) - 60 * 60;
      const res = await fetch(url, {
        method: 'POST',
        headers: signedHeaders('s', body, { ts: old }),
        body,
      });
      assert.equal(res.status, 401);
    });
  });

  it('rejects when nonce header is missing', async () => {
    await withServer('s', {}, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const headers = signedHeaders('s', body);
      delete headers['x-ifleet-nonce'];
      const res = await fetch(url, { method: 'POST', headers, body });
      assert.equal(res.status, 400);
    });
  });

  it('rejects a duplicate nonce within the skew window (replay protection)', async () => {
    let runCount = 0;
    await withServer('s', { onRun: () => runCount++ }, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const nonce = 'replay-test-nonce-1';
      const headers = signedHeaders('s', body, { nonce });
      const first = await fetch(url, { method: 'POST', headers, body });
      assert.equal(first.status, 202);
      const replay = await fetch(url, { method: 'POST', headers, body });
      assert.equal(replay.status, 409);
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(runCount, 1, 'replayed request must not trigger the handler twice');
  });

  it('drops oversize bodies and does not dispatch a truncated payload (CRIT-3)', async () => {
    let approvedId: string | undefined;
    await withServer('s', { onApprove: (id) => (approvedId = id) }, async (url) => {
      // 80KB JSON-shaped blob, well past the 64KB cap.
      const padding = 'x'.repeat(80 * 1024);
      const body = JSON.stringify({ type: 'approve', taskId: 't-big', padding });
      const headers = signedHeaders('s', body);
      // Either the server replies 413 or it destroys the socket mid-stream
      // because we hit the cap — both are acceptable outcomes of "stop
      // reading and refuse." What matters is that the handler is NEVER
      // dispatched with the truncated body (the CRIT-3 defect).
      try {
        const res = await fetch(url, { method: 'POST', headers, body });
        assert.ok(
          res.status === 413 || res.status >= 400,
          `unexpected status ${res.status} for oversize body`,
        );
      } catch (err) {
        // Socket-closed mid-write is also fine — it means the server
        // stopped reading rather than buffering 80KB+ of attacker input.
        assert.ok(err instanceof Error);
      }
    });
    // Wait briefly to give a hypothetical double-settlement a chance to fire.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(approvedId, undefined, 'truncated body must not dispatch the handler');
  });

  it('rejects nonces that are too short to be meaningful', async () => {
    await withServer('s', {}, async (url) => {
      const body = JSON.stringify({ type: 'run' });
      const headers = signedHeaders('s', body, { nonce: 'abc' });
      const res = await fetch(url, { method: 'POST', headers, body });
      assert.equal(res.status, 400);
    });
  });

  it('rejects missing headers', async () => {
    await withServer('s', {}, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"type":"run"}',
      });
      assert.equal(res.status, 401);
    });
  });

  it('404 on wrong path', async () => {
    await withServer('s', {}, async (url) => {
      const base = url.replace('/control', '/nope');
      const res = await fetch(base, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });

  it('GET /healthz returns 200', async () => {
    await withServer('s', {}, async (url) => {
      const base = url.replace('/control', '/healthz');
      const res = await fetch(base);
      assert.equal(res.status, 200);
      const json = (await res.json()) as { ok: boolean };
      assert.equal(json.ok, true);
    });
  });

  it('sprint_goal echoes taskId from handler', async () => {
    await withServer(
      's',
      { onSprintGoal: () => ({ taskId: 'task-123' }) },
      async (url) => {
        const body = JSON.stringify({ type: 'sprint_goal', goal: 'do thing' });
        const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
        assert.equal(res.status, 202);
        const json = (await res.json()) as { taskId?: string };
        assert.equal(json.taskId, 'task-123');
      },
    );
  });

  it('approve dispatches to onApprove', async () => {
    let approvedId: string | undefined;
    await withServer('s', { onApprove: (id) => (approvedId = id) }, async (url) => {
      const body = JSON.stringify({ type: 'approve', taskId: 't-1' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(approvedId, 't-1');
  });
});
