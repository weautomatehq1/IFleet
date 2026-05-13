import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { QueueAdapter, QueuedTask } from './types.js';

export type ControlCommand =
  | { type: 'sprint_goal'; goal: string; repo?: string }
  | { type: 'run'; repo?: string }
  | { type: 'cancel'; taskId: string; reason?: string }
  | { type: 'status'; taskId: string };

export interface ControlPlaneOptions {
  queue: QueueAdapter;
  hmacSecret: string;
  port: number;
  /** Max age (seconds) for a signed request before it is rejected as stale. */
  maxSkewSec?: number;
  /** Hook called when a new task should be created from a Discord goal. */
  onSprintGoal?: (goal: string, repo?: string) => Promise<void> | void;
  /** Hook called when a free-form "run" command arrives. */
  onRun?: (repo?: string) => Promise<void> | void;
  /** Resolver for taskId → QueuedTask used by `cancel`/`status`. */
  resolveTask?: (taskId: string) => Promise<QueuedTask | null> | QueuedTask | null;
}

export interface ControlPlane {
  server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const SIGNATURE_HEADER = 'x-ifleet-signature';
const TIMESTAMP_HEADER = 'x-ifleet-timestamp';
const DEFAULT_MAX_SKEW = 5 * 60;
const MAX_BODY_BYTES = 64 * 1024;

export function createControlPlane(opts: ControlPlaneOptions): ControlPlane {
  const maxSkew = opts.maxSkewSec ?? DEFAULT_MAX_SKEW;
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts, maxSkew).catch((err) => {
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
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlPlaneOptions,
  maxSkew: number,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/control') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const signature = headerOf(req, SIGNATURE_HEADER);
  const timestamp = headerOf(req, TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    res.statusCode = 401;
    res.end('missing signature headers');
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

  if (!verifySignature(opts.hmacSecret, timestamp, body, signature)) {
    res.statusCode = 401;
    res.end('bad signature');
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

  await dispatch(command, opts);
  res.statusCode = 202;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, type: command.type }));
}

async function dispatch(command: ControlCommand, opts: ControlPlaneOptions): Promise<void> {
  switch (command.type) {
    case 'sprint_goal':
      await opts.onSprintGoal?.(command.goal, command.repo);
      return;
    case 'run':
      await opts.onRun?.(command.repo);
      return;
    case 'cancel': {
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
      const cmd: ControlCommand = { type: 'sprint_goal', goal: parsed.goal };
      if (typeof parsed.repo === 'string') cmd.repo = parsed.repo;
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
      return cmd;
    }
    case 'status': {
      if (typeof parsed.taskId !== 'string') throw new Error('status requires taskId');
      return { type: 'status', taskId: parsed.taskId };
    }
    default:
      throw new Error(`unknown command type: ${parsed.type}`);
  }
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, timestamp, body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

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
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
