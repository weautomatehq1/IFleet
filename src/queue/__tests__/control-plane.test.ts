import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import {
  createControlPlane,
  parseCommand,
  signPayload,
  verifySignature,
} from '@wahq/orchestrator-core/queue/control-plane';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import type { QueueAdapter } from '@wahq/orchestrator-core/queue/types';

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
      onStatus?: (taskId: string) => string | null;
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

  it('verify round-trip — parseCommand + dispatch hits onVerify', async () => {
    assert.deepEqual(parseCommand('{"type":"verify","taskId":"t-v"}'), {
      type: 'verify',
      taskId: 't-v',
    });
    let verifiedId: string | undefined;
    const queue = noopQueue();
    const cp = createControlPlane({
      queue,
      hmacSecret: 's',
      port: 0,
      onVerify: (id) => {
        verifiedId = id;
      },
    });
    await cp.start();
    try {
      const addr = cp.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/control`;
      const body = JSON.stringify({ type: 'verify', taskId: 't-v' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
    } finally {
      await cp.stop();
    }
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(verifiedId, 't-v');
  });

  it('force_pr round-trip — parseCommand + dispatch hits onForcePr with reason', async () => {
    assert.deepEqual(parseCommand('{"type":"force_pr","taskId":"t-f","reason":"override"}'), {
      type: 'force_pr',
      taskId: 't-f',
      reason: 'override',
    });
    let forcedId: string | undefined;
    let forcedReason: string | undefined;
    const queue = noopQueue();
    const cp = createControlPlane({
      queue,
      hmacSecret: 's',
      port: 0,
      onForcePr: (id, reason) => {
        forcedId = id;
        forcedReason = reason;
      },
    });
    await cp.start();
    try {
      const addr = cp.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/control`;
      const body = JSON.stringify({ type: 'force_pr', taskId: 't-f', reason: 'override' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
    } finally {
      await cp.stop();
    }
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(forcedId, 't-f');
    assert.equal(forcedReason, 'override');
  });

  it('persists nonces across NonceStore instances (simulates restart) — AUDIT-IFleet-e664f9f3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifleet-nonce-ledger-'));
    const dbPath = join(dir, 'tasks.db');
    try {
      const ttlMs = 6 * 60 * 1000;
      const nonce = 'restart-survival-nonce';

      // Instance A — open store, register the nonce, then close the DB
      // handle. This mirrors the control-plane writing a record then PM2
      // restarting the process.
      const storeA = new TaskStore(dbPath);
      const ledgerA = storeA.createNonceLedger(ttlMs);
      assert.equal(ledgerA.registerOrReject(nonce), true, 'first registration succeeds');
      ledgerA.destroy();
      storeA.close();

      // Instance B — reopen the same DB file. The nonce written by A must
      // still be present, so the same nonce is rejected as a replay.
      const storeB = new TaskStore(dbPath);
      const ledgerB = storeB.createNonceLedger(ttlMs);
      assert.equal(
        ledgerB.registerOrReject(nonce),
        false,
        'replay must be rejected after restart',
      );
      ledgerB.destroy();
      storeB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires entries older than maxSkewSec on the next registration (TTL prune)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifleet-nonce-ttl-'));
    const dbPath = join(dir, 'tasks.db');
    try {
      const ttlMs = 5 * 60 * 1000;
      const store = new TaskStore(dbPath);
      const ledger = store.createNonceLedger(ttlMs);

      // Register a nonce as-if the clock were one hour ago. Its expires_at
      // is now in the past relative to the next call's `now`.
      const past = Date.now() - 60 * 60 * 1000;
      assert.equal(ledger.registerOrReject('stale-nonce', past), true);
      assert.equal(ledger.size(), 1, 'stale nonce was inserted');

      // Register a fresh nonce with the current clock. The opportunistic
      // prune inside registerOrReject must evict the stale entry first.
      assert.equal(ledger.registerOrReject('fresh-nonce'), true);
      assert.equal(
        ledger.size(),
        1,
        'stale entry must be evicted; only the fresh nonce remains',
      );

      ledger.destroy();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('race: two SqliteNonceLedger instances on the same DB accept a nonce exactly once — AUDIT-IFleet-63037351', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifleet-nonce-race-'));
    const dbPath = join(dir, 'tasks.db');
    try {
      const ttlMs = 6 * 60 * 1000;
      const nonce = 'race-test-nonce-identical';

      // Open two TaskStore/SqliteNonceLedger pairs on the same file.
      // This simulates two control-plane processes sharing the SQLite store.
      const storeA = new TaskStore(dbPath);
      const storeB = new TaskStore(dbPath);
      const ledgerA = storeA.createNonceLedger(ttlMs);
      const ledgerB = storeB.createNonceLedger(ttlMs);

      // Drive both calls within the same millisecond. Because better-sqlite3
      // is synchronous the calls serialize inside the process, but the UNIQUE
      // constraint on nonce_ledger ensures exactly one INSERT succeeds — the
      // loser's result.changes will be 0 (INSERT OR IGNORE, row already
      // present) and it returns false.
      const now = Date.now();
      const results = await Promise.all([
        Promise.resolve(ledgerA.registerOrReject(nonce, now)),
        Promise.resolve(ledgerB.registerOrReject(nonce, now)),
      ]);

      const trueCount = results.filter(Boolean).length;
      assert.equal(trueCount, 1, `exactly one registerOrReject must return true, got: ${JSON.stringify(results)}`);

      ledgerA.destroy();
      ledgerB.destroy();
      storeA.close();
      storeB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancel dispatch calls onCancel and does NOT call queue.markFailed', async () => {
    let onCancelCalled = false;
    let markFailedCalled = false;
    const queue: QueueAdapter = {
      ...noopQueue(),
      markFailed: async () => {
        markFailedCalled = true;
      },
    };
    const cp = createControlPlane({
      queue,
      hmacSecret: 's',
      port: 0,
      onCancel: () => {
        onCancelCalled = true;
      },
    });
    await cp.start();
    try {
      const addr = cp.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/control`;
      const body = JSON.stringify({ type: 'cancel', taskId: 't-c', reason: 'r' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
      // Response arrives AFTER onCancel completes (awaited dispatch).
      assert.equal(onCancelCalled, true, 'onCancel must run before response');
      assert.equal(markFailedCalled, false, 'queue.markFailed must not be invoked from dispatch');
    } finally {
      await cp.stop();
    }
  });

  it('status dispatch with onStatus returns message in response body', async () => {
    const queue = noopQueue();
    const cp = createControlPlane({
      queue,
      hmacSecret: 's',
      port: 0,
      onStatus: (taskId) => `state: in_flight\ntitle: test task\nid: ${taskId}`,
    });
    await cp.start();
    try {
      const addr = cp.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}/control`;
      const body = JSON.stringify({ type: 'status', taskId: 'task-123' });
      const res = await fetch(url, { method: 'POST', headers: signedHeaders('s', body), body });
      assert.equal(res.status, 202);
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(json['ok'], true);
      assert.ok(
        typeof json['message'] === 'string' && json['message'].includes('task-123'),
        'response must carry the status message',
      );
    } finally {
      await cp.stop();
    }
  });
});
