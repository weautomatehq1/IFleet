import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildSigningPayload, signPayload, verifyPayload } from '../contracts/hmac.js';
import type { QueueAdapter } from './types.js';

/**
 * Thrown by onSprintGoal handlers when the caller's request is malformed
 * (missing required Discord-source fields, duplicate dedup keys, etc.).
 * The HTTP layer catches this and returns 400 Bad Request rather than 500.
 * (AUDIT-IFleet-2fdb1535)
 */
export class ControlPlaneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneValidationError';
  }
}

/**
 * Server-internal command type used for JSON parsing and dispatch.
 * Canonical client-facing contract lives in {@link src/contracts/control-plane-client.ts}.
 * The two types differ: this one flattens Discord-source fields directly onto each variant;
 * the client type wraps them in a {@link DiscordCommandSource} object.
 */
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
  /** Host to bind the HTTP server to. Defaults to '127.0.0.1' (localhost only). */
  listenHost?: string;
  /** Max age (seconds) for a signed request before it is rejected as stale. */
  maxSkewSec?: number;
  /**
   * Replay-protection ledger. Production wiring passes a SQLite-backed
   * ledger from `TaskStore.createNonceLedger(...)` so replay protection
   * survives control-plane restart (AUDIT-IFleet-e664f9f3). If omitted, an
   * in-process Map-backed ledger is created — tests rely on this default.
   */
  nonceLedger?: NonceLedger;
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
  /** Hook for /status — returns a formatted status string, or null if nothing found. */
  onStatus?: (taskId: string) => Promise<string | null> | string | null;
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
const MAX_GOAL_LEN = 10_000;
const MAX_ID_FIELD_LEN = 64;
const MAX_LABEL_LEN = 256;
const MAX_KEY_LEN = 128;
const MAX_REASON_LEN = 1_000;

/**
 * Replay-protection ledger contract. Production wires a SQLite-backed
 * implementation (see `TaskStore.createNonceLedger` in `./store.ts`) so the
 * record survives control-plane restart. Tests default to the in-memory
 * fallback created below.
 */
export interface NonceLedger {
  /** Returns true if the nonce was fresh and is now recorded. False if already seen. */
  registerOrReject(nonce: string, now?: number): boolean;
  /** Release any owned resources (e.g. periodic timers). */
  destroy(): void;
}

/**
 * In-memory nonce ledger. Holds (nonce → expiresAtMs). On every request we
 * lazily sweep expired entries, then reject any nonce already in the map.
 * The TTL is `maxSkewSec + NONCE_TTL_PADDING_SEC` so an attacker who captured
 * a signed request cannot replay it inside the timestamp-skew window.
 *
 * Per-process state — does NOT survive restart. The production wiring in
 * `src/server.ts` passes a SQLite-backed ledger instead so PM2 restarts
 * cannot reopen the replay window (AUDIT-IFleet-e664f9f3). This class
 * remains for tests and for callers that don't want a DB dependency.
 */
export class MemoryNonceLedger implements NonceLedger {
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
  const nonceStore: NonceLedger =
    opts.nonceLedger ?? new MemoryNonceLedger((maxSkew + NONCE_TTL_PADDING_SEC) * 1000);
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
        server.listen(opts.port, opts.listenHost ?? '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        // Destroy nonce store AFTER server.close() so in-flight requests that
        // still call registerOrReject() don't hit a destroyed ledger
        // (AUDIT-IFleet-6e7fa111).
        server.close((err) => {
          nonceStore.destroy();
          if (err) reject(err); else resolve();
        });
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlPlaneOptions,
  maxSkew: number,
  nonceStore: NonceLedger,
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
    console.warn('[control-plane] auth rejected: invalid timestamp format');
    res.statusCode = 401;
    res.end('invalid timestamp');
    return;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > maxSkew) {
    console.warn(`[control-plane] auth rejected: timestamp skew ${skew}s exceeds max ${maxSkew}s`);
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
    console.warn('[control-plane] auth rejected: HMAC signature mismatch');
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
      // Validation errors from the handler are the caller's fault — 400, not 500.
      // (AUDIT-IFleet-2fdb1535)
      if (err instanceof ControlPlaneValidationError) {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end(err.message);
        }
        return;
      }
      console.error('[control-plane] sprint_goal handler failed:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('sprint_goal handler error');
      }
    }
    return;
  }

  try {
    const result = await dispatch(command, opts);
    res.statusCode = 202;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, type: command.type, ...result }));
  } catch (err) {
    console.error('[control-plane] dispatch failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('dispatch error');
    }
  }
}

async function dispatch(command: ControlCommand, opts: ControlPlaneOptions): Promise<{ message?: string }> {
  // `sprint_goal` is handled inline in handleRequest — it never reaches here.
  switch (command.type) {
    case 'sprint_goal':
      // Exhaustiveness guard only — handleRequest() intercepts sprint_goal before
      // calling dispatch(), so this branch is unreachable at runtime.
      throw new Error('sprint_goal must not reach dispatch()');
    case 'run':
      await opts.onRun?.(command.repo);
      return {};
    case 'approve':
      await opts.onApprove?.(command.taskId);
      return {};
    case 'cancel':
      // State transitions are owned by `onCancel` — it writes to the unified
      // store. The old queue.markFailed call was a dead path.
      await opts.onCancel?.(command.taskId, command.reason);
      return {};
    case 'status': {
      const message = await opts.onStatus?.(command.taskId);
      return message != null ? { message } : {};
    }
    case 'verify':
      await opts.onVerify?.(command.taskId);
      return {};
    case 'force_pr':
      await opts.onForcePr?.(command.taskId, command.reason);
      return {};
    case 'pause':
      await opts.onPause?.(command);
      return {};
    case 'continue':
      await opts.onContinue?.(command);
      return {};
    case 'stop':
      await opts.onStop?.(command);
      return {};
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
      if (parsed.goal.length > MAX_GOAL_LEN) {
        throw new Error('sprint_goal: goal exceeds maximum length');
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
      if (channelId) {
        if (channelId.length > MAX_ID_FIELD_LEN) throw new Error('sprint_goal: channelId exceeds maximum length');
        cmd.channelId = channelId;
      }
      const messageId = pickStr('messageId');
      if (messageId) {
        if (messageId.length > MAX_ID_FIELD_LEN) throw new Error('sprint_goal: messageId exceeds maximum length');
        cmd.messageId = messageId;
      }
      const userId = pickStr('userId');
      if (userId) {
        if (userId.length > MAX_ID_FIELD_LEN) throw new Error('sprint_goal: userId exceeds maximum length');
        cmd.userId = userId;
      }
      const userLabel = pickStr('userLabel');
      if (userLabel) {
        if (userLabel.length > MAX_LABEL_LEN) throw new Error('sprint_goal: userLabel exceeds maximum length');
        cmd.userLabel = userLabel;
      }
      const idempotencyKey = pickStr('idempotencyKey');
      if (idempotencyKey) {
        if (idempotencyKey.length > MAX_KEY_LEN) throw new Error('sprint_goal: idempotencyKey exceeds maximum length');
        cmd.idempotencyKey = idempotencyKey;
      }
      if (typeof parsed.planOnly === 'boolean') cmd.planOnly = parsed.planOnly;
      return cmd;
    }
    case 'run': {
      const cmd: ControlCommand = { type: 'run' };
      if (typeof parsed.repo === 'string') cmd.repo = parsed.repo;
      return cmd;
    }
    case 'cancel': {
      if (typeof parsed.taskId !== 'string' || parsed.taskId.trim().length === 0) throw new Error('cancel requires a non-empty taskId');
      if (parsed.taskId.length > MAX_ID_FIELD_LEN) throw new Error('cancel: taskId exceeds maximum length');
      const cmd: ControlCommand = { type: 'cancel', taskId: parsed.taskId };
      if (typeof parsed.reason === 'string') {
        if (parsed.reason.length > MAX_REASON_LEN) throw new Error('cancel: reason exceeds maximum length');
        cmd.reason = parsed.reason;
      }
      // Accept Discord audit fields either flat or nested under `source` so
      // /cancel without an explicit taskId can resolve the newest task in
      // this channel server-side (sentinel encoding in interaction-create).
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const pickStr = (k: string): string | undefined => {
        const v = source?.[k] ?? parsed[k];
        return typeof v === 'string' ? v : undefined;
      };
      const channelId = pickStr('channelId');
      if (channelId) {
        if (channelId.length > MAX_ID_FIELD_LEN) throw new Error('cancel: channelId exceeds maximum length');
        cmd.channelId = channelId;
      }
      const userLabel = pickStr('userLabel');
      if (userLabel) {
        if (userLabel.length > MAX_LABEL_LEN) throw new Error('cancel: userLabel exceeds maximum length');
        cmd.userLabel = userLabel;
      }
      return cmd;
    }
    case 'status': {
      if (typeof parsed.taskId !== 'string' || parsed.taskId.trim().length === 0) throw new Error('status requires a non-empty taskId');
      if (parsed.taskId.length > MAX_ID_FIELD_LEN) throw new Error('status: taskId exceeds maximum length');
      return { type: 'status', taskId: parsed.taskId };
    }
    case 'approve': {
      if (typeof parsed.taskId !== 'string' || parsed.taskId.trim().length === 0) throw new Error('approve requires a non-empty taskId');
      if (parsed.taskId.length > MAX_ID_FIELD_LEN) throw new Error('approve: taskId exceeds maximum length');
      return { type: 'approve', taskId: parsed.taskId };
    }
    case 'verify': {
      if (typeof parsed.taskId !== 'string' || parsed.taskId.trim().length === 0) throw new Error('verify requires a non-empty taskId');
      if (parsed.taskId.length > MAX_ID_FIELD_LEN) throw new Error('verify: taskId exceeds maximum length');
      return { type: 'verify', taskId: parsed.taskId };
    }
    case 'force_pr': {
      if (typeof parsed.taskId !== 'string' || parsed.taskId.trim().length === 0) throw new Error('force_pr requires a non-empty taskId');
      if (parsed.taskId.length > MAX_ID_FIELD_LEN) throw new Error('force_pr: taskId exceeds maximum length');
      const cmd: ControlCommand = { type: 'force_pr', taskId: parsed.taskId };
      if (typeof parsed.reason === 'string') {
        if (parsed.reason.length > MAX_REASON_LEN) throw new Error('force_pr: reason exceeds maximum length');
        cmd.reason = parsed.reason;
      }
      return cmd;
    }
    case 'pause': {
      const cmd: ControlCommand = { type: 'pause' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      if (reason) {
        if (reason.length > MAX_REASON_LEN) throw new Error('pause: reason exceeds maximum length');
        cmd.reason = reason;
      }
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) {
        if (userLabel.length > MAX_LABEL_LEN) throw new Error('pause: userLabel exceeds maximum length');
        cmd.userLabel = userLabel;
      }
      return cmd;
    }
    case 'continue': {
      const cmd: ControlCommand = { type: 'continue' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) {
        if (userLabel.length > MAX_LABEL_LEN) throw new Error('continue: userLabel exceeds maximum length');
        cmd.userLabel = userLabel;
      }
      return cmd;
    }
    case 'stop': {
      const cmd: ControlCommand = { type: 'stop' };
      const source = isRecord(parsed.source) ? parsed.source : undefined;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      if (reason) {
        if (reason.length > MAX_REASON_LEN) throw new Error('stop: reason exceeds maximum length');
        cmd.reason = reason;
      }
      const userLabel = typeof (source?.['userLabel'] ?? parsed.userLabel) === 'string'
        ? String(source?.['userLabel'] ?? parsed.userLabel)
        : undefined;
      if (userLabel) {
        if (userLabel.length > MAX_LABEL_LEN) throw new Error('stop: userLabel exceeds maximum length');
        cmd.userLabel = userLabel;
      }
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
