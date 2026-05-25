import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildSigningPayload, signPayload, verifyPayload } from '../contracts/hmac.js';
import type { QueueAdapter, QueuedTask } from './types.js';

export type ControlCommand =
  | {
      type: 'sprint_goal';
      goal: string;
      repo?: string;
      // Discord-source extras (T1 sets these for slash-command ingress).
      channelId?: string;
      messageId?: string;
      userId?: string;
      userLabel?: string;
      idempotencyKey?: string;
      planOnly?: boolean;
    }
  | { type: 'run'; repo?: string }
  | { type: 'cancel'; taskId: string; reason?: string; channelId?: string; userLabel?: string }
  | { type: 'status'; taskId: string }
  | { type: 'approve'; taskId: string }
  | { type: 'verify'; taskId: string }
  | { type: 'force_pr'; taskId: string; reason?: string }
  | { type: 'pause'; reason?: string; userLabel?: string }
  | { type: 'continue'; userLabel?: string }
  | { type: 'stop'; reason?: string; userLabel?: string };

export interface SprintGoalResult {
  taskId?: string;
  threadId?: string;
}

export interface ControlPlaneOptions {
  queue: QueueAdapter;
  hmacSecret: string;
  port: number;
  /** Max age (seconds) for a signed request before it is rejected as stale. */
  maxSkewSec?: number;
  /**
   * Hook called when a new task should be created. Receives the parsed
   * command (including Discord-source extras) so the handler can ingest
   * directly into the unified store. The returned taskId is echoed back to
   * the caller via the 202 body.
   */
  onSprintGoal?: (
    cmd: Extract<ControlCommand, { type: 'sprint_goal' }>,
  ) => Promise<SprintGoalResult | void> | SprintGoalResult | void;
  /** Hook called when a free-form "run" command arrives. */
  onRun?: (repo?: string) => Promise<void> | void;
  /** Hook called when an HITL approval is granted via Discord button or /approve. */
  onApprove?: (taskId: string) => Promise<void> | void;
  /** Optional pre-mark hook for cancel — useful for cleaning up worker state. */
  onCancel?: (taskId: string, reason?: string) => Promise<void> | void;
  /** Resolver for taskId → QueuedTask used by `cancel`/`status`. */
  resolveTask?: (taskId: string) => Promise<QueuedTask | null> | QueuedTask | null;
  /** Hook for /verify slash command — manual verifier rerun. */
  onVerify?: (taskId: string) => Promise<void> | void;
  /** Hook for [Force-PR] button override — open the PR despite verifier failures. */
  onForcePr?: (taskId: string, reason?: string) => Promise<void> | void;
  /** Hook for /pause — freeze the queue. Implementations should be idempotent. */
  onPause?: (cmd: Extract<ControlCommand, { type: 'pause' }>) => Promise<void> | void;
  /** Hook for /continue — thaw the queue. */
  onContinue?: (cmd: Extract<ControlCommand, { type: 'continue' }>) => Promise<void> | void;
  /** Hook for /stop — cancel everything in flight AND pause. */
  onStop?: (cmd: Extract<ControlCommand, { type: 'stop' }>) => Promise<void> | void;
}

export interface ControlPlane {
  server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const SIGNATURE_HEADER = 'x-ifleet-signature';
const TIMESTAMP_HEADER = 'x-ifleet-timestamp';
const NONCE_HEADER = 'x-ifleet-nonce';
const DEFAULT_MAX_SKEW = 5 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const NONCE_MIN_LEN = 8;
const NONCE_MAX_LEN = 64;
const NONCE_TTL_PADDING_SEC = 60;

/**
 * In-memory nonce ledger. Holds (nonce → expiresAtMs). On every request we
 * lazily sweep expired entries, then reject any nonce already in the map.
 * The TTL is `maxSkewSec + NONCE_TTL_PADDING_SEC` so an attacker who captured
 * a signed request cannot replay it inside the timestamp-skew window.
 *
 * This is per-process state — control-plane is single-process today. If we
 * ever run multi-instance behind a load balancer the store has to move to a
 * shared backend (sqlite/redis); the call site stays the same.
 */
class NonceStore {
  private readonly seen = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly ttlMs: number) {
    // Periodic sweep so the ledger doesn't grow unboundedly in low-traffic periods
    // where the lazy per-request sweep never fires.
    this.timer = setInterval(() => this.sweep(Date.now()), 60_000).unref();
  }

  destroy(): void {
    clearInterval(this.timer);
  }

  /** Returns true if the nonce was fresh and is now recorded. False if seen. */
  registerOrReject(nonce: string, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }
}

export function createControlPlane(opts: ControlPlaneOptions): ControlPlane {
  const maxSkew = opts.maxSkewSec ?? DEFAULT_MAX_SKEW;
  const nonceStore = new NonceStore((maxSkew + NONCE_TTL_PADDING_SEC) * 1000);
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts, maxSkew, nonceStore).catch((err) => {
      console.error('[control-plane] unhandled error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  return {
    server,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        nonceStore.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlPlaneOptions,
  maxSkew: number,
  nonceStore: NonceStore,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    // Unauthenticated endpoint; do not surface version/build info to
    // anonymous callers (fingerprinting aid).
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/control') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const signature = headerOf(req, SIGNATURE_HEADER);
  const timestamp = headerOf(req, TIMESTAMP_HEADER);
  const nonce = headerOf(req, NONCE_HEADER);
  if (!signature || !timestamp) {
    res.statusCode = 401;
    res.end('missing signature headers');
    return;
  }
  if (!nonce) {
    res.statusCode = 400;
    res.end('missing nonce header');
    return;
  }
  if (nonce.length < NONCE_MIN_LEN || nonce.length > NONCE_MAX_LEN) {
    res.statusCode = 400;
    res.end('invalid nonce length');
    return;
  }

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    res.statusCode = 401;
    res.end('invalid timestamp');
    return;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > maxSkew) {
    res.statusCode = 401;
    res.end('timestamp out of range');
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    res.statusCode = err instanceof PayloadTooLargeError ? 413 : 400;
    res.end(err instanceof Error ? err.message : 'bad body');
    return;
  }

  if (!verifyPayload({ timestamp, nonce, body }, opts.hmacSecret, signature)) {
    res.statusCode = 401;
    res.end('bad signature');
    return;
  }

  // Signature ok — only now spend a nonce-store slot. Otherwise an attacker
  // could exhaust the ledger with garbage requests.
  if (!nonceStore.registerOrReject(nonce)) {
    res.statusCode = 409;
    res.end('nonce already used');
    return;
  }

  let command: ControlCommand;
  try {
    command = parseCommand(body);
  } catch (err) {
    res.statusCode = 400;
    res.end(err instanceof Error ? err.message : 'bad command');
    return;
  }

  // sprint_goal waits for the handler so T1 can surface taskId/threadId in
  // its slash-command reply. Other commands are fire-and-forget (202).
  if (command.type === 'sprint_goal') {
    try {
      const result = (await opts.onSprintGoal?.(command)) ?? {};
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, type: command.type, ...result }));
    } catch (err) {
      console.error('[control-plane] sprint_goal handler failed:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('sprint_goal handler error');
      }
    }
    return;
  }

  res.statusCode = 202;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, type: command.type }));
  void dispatch(command, opts).catch((err) => {
    console.error('[control-plane] dispatch failed:', err);
  });
}

async function dispatch(command: ControlCommand, opts: ControlPlaneOptions): Promise<void> {
  // `sprint_goal` is handled inline in handleRequest (so the caller can read
  // back taskId/threadId) — it never reaches dispatch.
  switch (command.type) {
    case 'sprint_goal':
      return;
    case 'run':
      await opts.onRun?.(command.repo);
      return;
    case 'approve':
      await opts.onApprove?.(command.taskId);
      return;
    case 'cancel': {
      await opts.onCancel?.(command.taskId, command.reason);
      const task = await opts.resolveTask?.(command.taskId);
      if (task) {
        await opts.queue.markFailed(task, command.reason ?? 'cancelled via control plane');
      }
      return;
    }
    case 'status': {
      const task = await opts.resolveTask?.(command.taskId);
      if (task) {
        await opts.queue.postStatus(task, 'reviewing', 'status requested via control plane');
      }
      return;
    }
    case 'verify':
      await opts.onVerify?.(command.taskId);
      return;
    case 'force_pr':
      await opts.onForcePr?.(command.taskId, command.reason);
      return;
    case 'pause':
      await opts.onPause?.(command);
      return;
    case 'continue':
      await opts.onContinue?.(command);
      return;
    case 'stop':
      await opts.onStop?.(command);
      return;
  }
}

export function parseCommand(body: string): ControlCommand {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('command must be an object with type');
  }
  switch (parsed.type) {
    case 'sprint_goal': {
      if (typeof parsed.goal !== 'string' || parsed.goal.trim().length === 0) {
        throw new Error('sprint_goal requires goal');
      }
      // Accept Discord audit fields either flat (legacy) or nested under
      // `source` (current client contract — DiscordCommandSource). Nested
      // takes precedence. Server normalizes to flat for downstream handlers.
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const pickStr = (k: string): string | undefined => {
        const v = source?.[k] ?? parsed[k];
        return typeof v === 'string' ? v : undefined;
      };
      const cmd: ControlCommand = { type: 'sprint_goal', goal: parsed.goal };
      if (typeof parsed.repo === 'string') cmd.repo = parsed.repo;
      const channelId = pickStr('channelId');
      if (channelId) cmd.channelId = channelId;
      const messageId = pickStr('messageId');
      if (messageId) cmd.messageId = messageId;
      const userId = pickStr('userId');
      if (userId) cmd.userId = userId;
      const userLabel = pickStr('userLabel');
      if (userLabel) cmd.userLabel = userLabel;
      if (typeof parsed.idempotencyKey === 'string') cmd.idempotencyKey = parsed.idempotencyKey;
      if (typeof parsed.planOnly === 'boolean') cmd.planOnly = parsed.planOnly;
      return cmd;
    }
    case 'run': {
      const cmd: ControlCommand = { type: 'run' };
      if (typeof parsed.repo === 'string') cmd.repo = parsed.repo;
      return cmd;
    }
    case 'cancel': {
      if (typeof parsed.taskId !== 'string') throw new Error('cancel requires taskId');
      const cmd: ControlCommand = { type: 'cancel', taskId: parsed.taskId };
      if (typeof parsed.reason === 'string') cmd.reason = parsed.reason;
      // Accept Discord audit fields either flat or nested under `source` so
      // /cancel without an explicit taskId can resolve the newest task in
      // this channel server-side (sentinel encoding in interaction-create).
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const pickStr = (k: string): string | undefined => {
        const v = source?.[k] ?? parsed[k];
        return typeof v === 'string' ? v : undefined;
      };
      const channelId = pickStr('channelId');
      if (channelId) cmd.channelId = channelId;
      const userLabel = pickStr('userLabel');
      if (userLabel) cmd.userLabel = userLabel;
      return cmd;
    }
    case 'status': {
      if (typeof parsed.taskId !== 'string') throw new Error('status requires taskId');
      return { type: 'status', taskId: parsed.taskId };
    }
    case 'approve': {
      if (typeof parsed.taskId !== 'string') throw new Error('approve requires taskId');
      return { type: 'approve', taskId: parsed.taskId };
    }
    case 'verify': {
      if (typeof parsed.taskId !== 'string') throw new Error('verify requires taskId');
      return { type: 'verify', taskId: parsed.taskId };
    }
    case 'force_pr': {
      if (typeof parsed.taskId !== 'string') throw new Error('force_pr requires taskId');
      const cmd: ControlCommand = { type: 'force_pr', taskId: parsed.taskId };
      if (typeof parsed.reason === 'string') cmd.reason = parsed.reason;
      return cmd;
    }
    case 'pause': {
      const cmd: ControlCommand = { type: 'pause' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      if (reason) cmd.reason = reason;
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) cmd.userLabel = userLabel;
      return cmd;
    }
    case 'continue': {
      const cmd: ControlCommand = { type: 'continue' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) cmd.userLabel = userLabel;
      return cmd;
    }
    case 'stop': {
      const cmd: ControlCommand = { type: 'stop' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      if (reason) cmd.reason = reason;
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) cmd.userLabel = userLabel;
      return cmd;
    }
    default:
      throw new Error(`unknown command type: ${parsed.type}`);
  }
}

// Re-export the shared HMAC primitives. Existing call sites and tests import
// `signPayload`/`verifySignature` from this module — keep that surface stable
// while routing through src/contracts/hmac.ts so the signer never drifts.
export function signLegacyPayload(secret: string, timestamp: string, nonce: string, body: string): string {
  return signPayload({ timestamp, nonce, body }, secret);
}

export function verifySignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
): boolean {
  return verifyPayload({ timestamp, nonce, body }, secret, signature);
}

// Re-export for callers/tests that pull the shared primitives off this module.
export { buildSigningPayload, signPayload };

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // `req.destroy()` after `reject()` does not guarantee the `end` listener
    // is unhooked — on some Node versions a queued `end` still fires and
    // would resolve the promise after it already rejected, leaking a
    // truncated body through to `verifyPayload`. A single-settlement guard
    // ensures exactly one of {resolve, reject} runs.
    let settled = false;
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settleReject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settleResolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: Error) => settleReject(err));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
