// Fleet-wide pause/continue/stop primitives.
//
// IFleet runs one task at a time (single Claude Max seat) but the queue
// behind it can stack. /pause freezes new pickups without killing the
// running task; /continue thaws it; /stop cancels everything in flight
// AND pauses. The pause state is a flag file (.omc/PAUSED) so it survives
// daemon restarts and is shared between the smoke runner cron and the
// long-running daemon.

import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FLAG_REL = '.omc/PAUSED';

export interface PauseInfo {
  paused: boolean;
  since?: string;
  reason?: string;
  by?: string;
}

/**
 * Repo root used for the PAUSED flag. Both daemon and smoke runner consult
 * `IFLEET_REPO_ROOT` first so worktree-relative invocations still hit the
 * canonical flag location on the VPS.
 */
export function fleetRepoRoot(): string {
  return process.env['IFLEET_REPO_ROOT'] ?? process.cwd();
}

/** Absolute path to the PAUSED flag, given an optional repo root. */
export function pausedFlagPath(repoRoot?: string): string {
  return join(repoRoot ?? fleetRepoRoot(), FLAG_REL);
}

/** True if the fleet is currently paused (flag file present). */
export function isFleetPaused(repoRoot?: string): boolean {
  return existsSync(pausedFlagPath(repoRoot));
}

/**
 * Read the contents of the pause flag — populated by setFleetPaused so
 * /status and Discord pings can echo back who paused and why.
 */
export function readPauseInfo(repoRoot?: string): PauseInfo {
  const path = pausedFlagPath(repoRoot);
  if (!existsSync(path)) return { paused: false };
  try {
    const body = readFileSync(path, 'utf8').trim();
    if (!body) {
      // Touched without metadata (legacy `npm run fleet:pause`). Fall back
      // to file mtime so callers always get a timestamp.
      const mt = statSync(path).mtime.toISOString();
      return { paused: true, since: mt };
    }
    const parsed = JSON.parse(body) as Partial<PauseInfo>;
    return {
      paused: true,
      ...(parsed.since ? { since: parsed.since } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.by ? { by: parsed.by } : {}),
    };
  } catch {
    return { paused: true };
  }
}

/** Set the PAUSED flag with metadata. Idempotent — overwrites prior content. */
export function setFleetPaused(opts: { reason?: string; by?: string } = {}, repoRoot?: string): void {
  const path = pausedFlagPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({
    since: new Date().toISOString(),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.by ? { by: opts.by } : {}),
  });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, body, 'utf8');
  renameSync(tmpPath, path);
}

/** Remove the PAUSED flag. No-op when the flag is already absent. */
export function clearFleetPause(repoRoot?: string): void {
  rmSync(pausedFlagPath(repoRoot), { force: true });
}
