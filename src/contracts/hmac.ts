// Shared HMAC primitive used by both the Discord-side signer
// (src/discord/hmac-client.ts) and the ControlPlane server
// (src/queue/control-plane.ts). Keeping a single implementation prevents
// signer/verifier drift — every additive change to the wire format (e.g. the
// nonce field added for replay protection) is made here exactly once.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SigningPayloadArgs {
  timestamp: string;
  nonce: string;
  body: string;
}

/**
 * Canonical string fed into the HMAC. The nonce is part of the signed payload
 * so an attacker cannot replay a captured signature by injecting a different
 * nonce header — the server recomputes the HMAC with the supplied nonce and
 * rejects on mismatch.
 */
export function buildSigningPayload(args: SigningPayloadArgs): string {
  return `${args.timestamp}.${args.nonce}.${args.body}`;
}

export function signPayload(args: SigningPayloadArgs, secret: string): string {
  return createHmac('sha256', secret).update(buildSigningPayload(args)).digest('hex');
}

export function verifyPayload(
  args: SigningPayloadArgs,
  secret: string,
  providedSignatureHex: string,
): boolean {
  if (typeof providedSignatureHex !== 'string' || providedSignatureHex.length === 0) {
    return false;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignatureHex, 'hex');
  } catch {
    return false;
  }
  const expected = Buffer.from(signPayload(args, secret), 'hex');
  if (expected.length === 0 || provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}
