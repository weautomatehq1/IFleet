import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AddressInfo } from 'node:net';
import {
  createControlPlane,
  parseCommand,
  signPayload,
  verifySignature,
} from '../control-plane.js';
import type { QueueAdapter, QueuedTask } from '../types.js';

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

describe('verifySignature', () => {
  it('round-trips a known signature', () => {
    const secret = 'shh';
    const body = '{"type":"run"}';
    const ts = '1700000000';
    const sig = signPayload(secret, ts, body);
    assert.ok(verifySignature(secret, ts, body, sig));
  });

  it('rejects modified bodies', () => {
    const sig = signPayload('shh', '1', '{}');
    assert.equal(verifySignature('shh', '1', '{"x":1}', sig), false);
  });

  it('rejects wrong secret', () => {
    const sig = signPayload('shh', '1', '{}');
    assert.equal(verifySignature('other', '1', '{}', sig), false);
  });

  it('rejects length-mismatched signatures (timing-safe compare safe)', () => {
    assert.equal(verifySignature('shh', '1', '{}', 'ab'), false);
    assert.equal(verifySignature('shh', '1', '{}', ''), false);
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
    handler: { onRun?: () => void; onSprintGoal?: (goal: string) => void; resolveTask?: () => QueuedTask | null },
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

  function signedHeaders(secret: string, body: string, ts?: number): Record<string, string> {
    const timestamp = String(ts ?? Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      'x-ifleet-timestamp': timestamp,
      'x-ifleet-signature': signPayload(secret, timestamp, body),
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
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body, old), body });
      assert.equal(res.status, 401);
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
});
