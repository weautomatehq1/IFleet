// CI-failure fingerprints. When a sprint fails, doctor hashes the failure
// signature (error kind + top stack frames) and consults `.omc/fingerprints.json`.
// If the same hash was seen before with a known fix commit, surface that
// hint to the editor; otherwise record the new hash so future runs can match.
//
// Hash format: sha256(errorKind + '\n' + topFrames.join('\n')).slice(0,16)
// Same input → same hash, deterministic across processes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Fingerprint {
  first_seen: string;
  count: number;
  last_fix_commit?: string;
  tag: string;
}

export type FingerprintStore = Record<string, Fingerprint>;

export interface FingerprintMatch {
  hash: string;
  tag: string;
  prior?: Fingerprint;
}

const HASH_LEN = 16;
const MAX_FRAMES = 3;

/**
 * Compute a deterministic fingerprint of a CI failure log. Strips line numbers
 * and absolute paths so the same error from different machines hashes the same.
 */
export function computeFingerprint(ciLog: string): { hash: string; tag: string } {
  const errorKind = extractErrorKind(ciLog);
  const frames = extractTopFrames(ciLog, MAX_FRAMES);
  const canonical = [errorKind, ...frames].join('\n');
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LEN);
  return { hash, tag: errorKind || 'unknown' };
}

/**
 * Find a previously-seen fingerprint. Returns undefined for first-time failures.
 */
export function matchFingerprint(
  store: FingerprintStore,
  hash: string,
): Fingerprint | undefined {
  return store[hash];
}

/**
 * Insert a new fingerprint or increment the count on an existing one. The
 * `first_seen` timestamp is preserved across increments.
 */
export function recordFingerprint(
  store: FingerprintStore,
  hash: string,
  tag: string,
  now: Date = new Date(),
): FingerprintStore {
  const existing = store[hash];
  if (existing) {
    store[hash] = { ...existing, count: existing.count + 1, tag };
  } else {
    store[hash] = {
      first_seen: now.toISOString(),
      count: 1,
      tag,
    };
  }
  return store;
}

/**
 * Attach a fix commit SHA to a fingerprint. No-op if the hash is unknown.
 */
export function attachFix(
  store: FingerprintStore,
  hash: string,
  commitSha: string,
): FingerprintStore {
  const existing = store[hash];
  if (existing) {
    store[hash] = { ...existing, last_fix_commit: commitSha };
  }
  return store;
}

export function loadFingerprints(path: string): FingerprintStore {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FingerprintStore;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveFingerprints(path: string, store: FingerprintStore): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Build a one-line hint suitable for prepending to the doctor's brief. Returns
 * empty string when there is nothing useful to surface.
 */
export function formatPriorFixHint(prior: Fingerprint | undefined): string {
  if (!prior) return '';
  const fixRef = prior.last_fix_commit ? ` last fixed in commit ${prior.last_fix_commit}` : '';
  return `Prior fingerprint match: "${prior.tag}" seen ${prior.count}x since ${prior.first_seen}${fixRef}.`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull the most diagnostic line out of a CI log. We look for, in order:
 *   1. `Error:` / `TypeError:` / `RangeError:` etc.
 *   2. `error TSxxxx:` (tsc) or `error: ...` (lint)
 *   3. Vitest/jest "FAIL" line
 * Fallback to the first non-empty line. Path-like substrings are stripped so
 * the hash stays stable across machines.
 */
function extractErrorKind(log: string): string {
  if (!log) return '';
  const lines = log.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const errMatch = /^([A-Z][A-Za-z]*Error):\s*(.+)$/.exec(line);
    if (errMatch) return stripPaths(`${errMatch[1]}: ${errMatch[2]}`);
    const tsMatch = /\berror TS\d{4}:\s*(.+)$/.exec(line);
    if (tsMatch) return stripPaths(`tsc: ${tsMatch[1]}`);
    const lintMatch = /^\s*error\s+(.+)$/.exec(line);
    if (lintMatch) return stripPaths(`lint: ${lintMatch[1]}`);
    const failMatch = /^FAIL\s+(.+)$/.exec(line);
    if (failMatch) return stripPaths(`test-fail: ${failMatch[1]}`);
  }
  return stripPaths(lines.find((l) => l.trim())?.trim() ?? '');
}

/**
 * Grab the top N `at fn (path:line:col)` frames. Paths are reduced to basenames
 * and line/col stripped so a refactor that renumbers lines does not invalidate
 * the fingerprint.
 */
function extractTopFrames(log: string, max: number): string[] {
  if (!log) return [];
  const frames: string[] = [];
  for (const raw of log.split('\n')) {
    const m = /^\s*at\s+(.+?)\s+\((?:.*?\/)?([^/\s):]+)(?::\d+)?(?::\d+)?\)/.exec(raw);
    if (m) {
      frames.push(`at ${m[1]} (${m[2]})`);
      if (frames.length >= max) break;
      continue;
    }
    const bareM = /^\s*at\s+(?:.*?\/)?([^/\s:]+)(?::\d+)?(?::\d+)?\s*$/.exec(raw);
    if (bareM) {
      frames.push(`at ${bareM[1]}`);
      if (frames.length >= max) break;
    }
  }
  return frames;
}

function stripPaths(s: string): string {
  // Collapse absolute-style paths to basenames so /Users/foo/x.ts and
  // /home/bar/x.ts hash identically.
  return s.replace(/(\/[A-Za-z0-9_.-]+)+\/([A-Za-z0-9_.-]+)/g, '$2');
}
