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

import { request } from 'node:https';

const ENV_VAR = 'DISCORD_IFLEET_WEBHOOK';

let warnedUnset = false;

/**
 * Post `msg` to the IFleet broadcast Discord webhook. Returns immediately —
 * the HTTP request is fired and forgotten. Failures never throw; HTTP errors
 * are swallowed because a broadcast failure must not unwind the pipeline.
 *
 * The first call with an unset webhook env warns once on stderr so silent
 * misconfiguration is detectable in pm2 logs.
 */
export function broadcastIFleet(msg: string): void {
  const url = process.env[ENV_VAR];
  if (!url) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn(
        `[broadcast] ${ENV_VAR} is not set — IFleet task events will not surface to Discord. ` +
          `Set it in the PM2 ecosystem so silent failures stop happening.`,
      );
    }
    return;
  }
  const body = JSON.stringify({ content: msg });
  try {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
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
