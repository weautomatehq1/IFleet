/**
 * Tiny JSON file that remembers whether the verifier↔reviewer disagreement
 * canary was *last seen* above or below threshold. The alerter uses this to
 * fire Discord posts only on transitions, so the cron doesn't repost the
 * same warning every tick.
 *
 * File-based because (a) there are exactly two long-lived rows (current
 * state + last-fired-at) and (b) we want zero coupling to the orchestrator
 * SQLite schema — adding a table for this would burn a migration on a
 * trivial KV.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CanaryStateKind = 'unknown' | 'below' | 'above';

export interface CanaryState {
  kind: CanaryStateKind;
  /** Rate at the time of the last *transition* (not every cron tick). */
  lastTransitionRate: number | null;
  /** ms-since-epoch of the last transition. */
  lastTransitionAtMs: number | null;
}

const INITIAL_STATE: CanaryState = {
  kind: 'unknown',
  lastTransitionRate: null,
  lastTransitionAtMs: null,
};

export interface CanaryStateStoreOptions {
  /** Absolute path to the JSON file. Defaults to `.ifleet/canary/alert-state.json`. */
  path?: string;
}

export class CanaryStateStore {
  private readonly path: string;

  constructor(opts: CanaryStateStoreOptions = {}) {
    this.path = opts.path ?? resolve(process.cwd(), '.ifleet/canary/alert-state.json');
  }

  read(): CanaryState {
    if (!existsSync(this.path)) return { ...INITIAL_STATE };
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CanaryState>;
      return {
        kind: parsed.kind === 'above' || parsed.kind === 'below' ? parsed.kind : 'unknown',
        lastTransitionRate:
          typeof parsed.lastTransitionRate === 'number' ? parsed.lastTransitionRate : null,
        lastTransitionAtMs:
          typeof parsed.lastTransitionAtMs === 'number' ? parsed.lastTransitionAtMs : null,
      };
    } catch {
      // Corrupt file: treat as unknown so the next transition fires fresh.
      return { ...INITIAL_STATE };
    }
  }

  write(next: CanaryState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
}
