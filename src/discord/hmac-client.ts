import { randomUUID } from 'node:crypto';
import { signPayload } from '../contracts/hmac.js';
import type {
  ControlCommand,
  ControlPlaneAck,
  ControlPlaneClient,
} from '../contracts/control-plane-client.js';

export interface HmacControlPlaneClientOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam — produce a fresh nonce per request. Defaults to randomUUID(). */
  nonceFactory?: () => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Re-exported for callers/tests that still import `signPayload` from this
// module. The implementation now lives in src/contracts/hmac.ts.
export { signPayload } from '../contracts/hmac.js';

export class HmacControlPlaneClient implements ControlPlaneClient {
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nonceFactory: () => string;

  constructor(opts: HmacControlPlaneClientOptions) {
    if (!opts.url) throw new Error('HmacControlPlaneClient: url is required');
    if (!opts.secret) throw new Error('HmacControlPlaneClient: secret is required');
    this.url = opts.url;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nonceFactory = opts.nonceFactory ?? (() => randomUUID());
  }

  async postCommand(cmd: ControlCommand): Promise<ControlPlaneAck> {
    const body = JSON.stringify(cmd);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = this.nonceFactory();
    const signature = signPayload({ timestamp, nonce, body }, this.secret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ifleet-timestamp': timestamp,
          'x-ifleet-nonce': nonce,
          'x-ifleet-signature': signature,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new ControlPlaneError(res.status, text || res.statusText, cmd.type);
    }

    const text = await safeText(res);
    if (!text) return { accepted: true };
    try {
      const parsed: unknown = JSON.parse(text);
      if (isAck(parsed)) return parsed;
      return { accepted: true, message: text };
    } catch {
      return { accepted: true, message: text };
    }
  }
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly commandType: ControlCommand['type'],
  ) {
    super(`ControlPlane ${status} for ${commandType}: ${responseBody}`);
    this.name = 'ControlPlaneError';
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function isAck(value: unknown): value is ControlPlaneAck {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['accepted'] === 'boolean') return true;
  if (typeof v['ok'] === 'boolean') {
    v['accepted'] = v['ok'] as boolean;
    return true;
  }
  return false;
}
