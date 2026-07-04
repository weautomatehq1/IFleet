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
  // Always compute expected first so timing is constant regardless of whether
  // the provided hex is parseable.
  const expected = Buffer.from(signPayload(args, secret), 'hex');
  // Pad provided to expected length so timingSafeEqual never short-circuits on
  // length mismatch — prevents timing side-channel that reveals signature length.
  const raw = Buffer.from(providedSignatureHex, 'hex');
  const provided = raw.length === expected.length ? raw : Buffer.alloc(expected.length);
  // A zero-length expected means the HMAC function failed — reject immediately.
  if (expected.length === 0) return false;
  // A mis-sized provided buffer was padded to zeros above; those always fail
  // timingSafeEqual, so no separate length check is needed.
  return timingSafeEqual(expected, provided);
}
