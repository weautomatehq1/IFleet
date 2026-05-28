// Fire-and-forget Discord webhook broadcaster. Used by every IFleet entry
// point (smoke runner cron + daemon orchestrator) to push task lifecycle
// events to a single channel so silence always means "no work in flight"
// rather than "work in flight but failing invisibly".
//
// Per feedback (2026-05-25): the original token-burn incident happened
// because GitHub-source pipeline failures from the smoke runner had no
// fallback channel notification when DISCORD_IFLEET_WEBHOOK was unset or
// when the worker crashed before notify() ran. This module centralises the
// HTTP path so both the cron + daemon use the same wire format, and it
// fails LOUD (warn on unset env) instead of silently no-oping.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const ENV_VAR = 'DISCORD_IFLEET_WEBHOOK';

// Discord webhook hard cap is 2000 chars for `content`; leave headroom for
// any wrapping the caller forgot (markdown fences, ellipsis).
const MAX_CONTENT_LEN = 1900;

// Discord webhook rate limit is 30 req/min (5 burst per 2s). 2000ms minimum
// spacing between sends keeps us under both limits even when /stop cancels
// N tasks back-to-back. Closes AUDIT-IFleet-2e7a838d / AUDIT-IFleet-7912f2d9.
const MIN_INTERVAL_MS = 2000;

// Cap on the number of pending (setTimeout-scheduled) sends per URL. A burst
// of thousands of broadcastIFleet calls would otherwise queue indefinitely,
// saturating memory and delaying other events for tens of minutes.
// Closes AUDIT-IFleet-5a7c8562.
const MAX_QUEUE_DEPTH = 50;

// Per-URL state so the module-level flag doesn't leak across parallel test
// runs (each test that mutates DISCORD_IFLEET_WEBHOOK gets its own slot).
// Closes AUDIT-IFleet-40f6cad5.
interface BroadcastState {
  warnedUnset: boolean;
  lastSentAt: number;
  pendingCount: number;
}
const stateByUrl = new Map<string, BroadcastState>();

// Key for the "unset" state — every callsite without a webhook URL shares one
// slot so the warn-once still fires only once per process when nothing is set.
const UNSET_KEY = '__unset__';

function getState(key: string): BroadcastState {
  let s = stateByUrl.get(key);
  if (!s) {
    s = { warnedUnset: false, lastSentAt: 0, pendingCount: 0 };
    stateByUrl.set(key, s);
  }
  return s;
}

function truncate(msg: string): string {
  if (msg.length <= MAX_CONTENT_LEN) return msg;
  // Reserve one char for the ellipsis so the wire payload stays under cap.
  return msg.slice(0, MAX_CONTENT_LEN - 1) + '…';
}

/**
 * Post `msg` to the IFleet broadcast Discord webhook. Returns immediately —
 * the HTTP request is fired and forgotten. Failures never throw; HTTP errors
 * are swallowed because a broadcast failure must not unwind the pipeline.
 *
 * The first call with an unset webhook env warns once on stderr so silent
 * misconfiguration is detectable in pm2 logs.
 *
 * Messages over 1900 chars are truncated (Discord caps `content` at 2000).
 * Sends are spaced ≥ MIN_INTERVAL_MS apart to stay under Discord's 30/min
 * webhook rate limit even when /stop cancels many tasks at once.
 */
export function broadcastIFleet(msg: string): void {
  const url = process.env[ENV_VAR];
  if (!url) {
    const s = getState(UNSET_KEY);
    if (!s.warnedUnset) {
      s.warnedUnset = true;
      console.warn(
        `[broadcast] ${ENV_VAR} is not set — IFleet task events will not surface to Discord. ` +
          `Set it in the PM2 ecosystem so silent failures stop happening.`,
      );
    }
    return;
  }

  // Rate-limit: schedule the send so it lands ≥ MIN_INTERVAL_MS after the
  // last send for the same URL. Caller still returns synchronously; the
  // setTimeout keeps the fire-and-forget contract.
  //
  // Always use the setTimeout path (even for delay=0) so pendingCount covers
  // both immediate and delayed sends uniformly. Closes AUDIT-IFleet-cd19ee4c.
  const state = getState(url);
  const now = Date.now();
  const delay = Math.max(0, state.lastSentAt + MIN_INTERVAL_MS - now);
  state.lastSentAt = now + delay;
  if (state.pendingCount >= MAX_QUEUE_DEPTH) {
    console.warn(
      `[broadcast] queue depth ${state.pendingCount} >= ${MAX_QUEUE_DEPTH} — dropping message`,
    );
    return;
  }
  state.pendingCount++;
  setTimeout(() => {
    state.pendingCount--;
    sendNow(url, truncate(msg));
  }, delay).unref();
}

function sendNow(url: string, msg: string): void {
  const body = JSON.stringify({ content: msg });
  try {
    const parsed = new URL(url);
    // Closes AUDIT-IFleet-91db3b82: integration/dev setups may point at an
    // http://localhost mock; default to https for prod webhook URLs.
    const request = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => { res.resume(); },
    );
    req.on('error', (err) => {
      console.warn(`[broadcast] webhook POST errored: ${err.message}`);
    });
    req.write(body);
    req.end();
  } catch (err) {
    console.warn(
      `[broadcast] webhook POST threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reset module-level broadcast state. Test-only helper — production code
 * never calls this. Exported so test suites can isolate `warnedUnset` and
 * `lastSentAt` between runs without sharing module-level state.
 */
export function __resetBroadcastStateForTests(): void {
  stateByUrl.clear();
}
