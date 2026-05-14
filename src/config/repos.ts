import { readFileSync } from 'node:fs';

export interface RepoEntry {
  owner: string;
  name: string;
}

/** Map keyed by "owner/name". */
export type ReposMap = Record<string, RepoEntry>;

export const DEFAULT_REPO_ID = 'weautomatehq1/IFleet';

/**
 * Reads and migrates `config/repos.json` on first load. Handles both the
 * legacy array format (`{ repos: [...] }`) and the current map format
 * (`{ "owner/name": { owner, name } }`). Migration is idempotent.
 */
export function loadReposConfig(filePath: string): ReposMap {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  return migrateReposConfig(raw);
}

export function migrateReposConfig(raw: unknown): ReposMap {
  if (isNewFormat(raw)) return raw;
  if (isLegacyFormat(raw)) {
    return Object.fromEntries(
      raw.repos.map((entry) => [`${entry.owner}/${entry.name}`, entry]),
    );
  }
  throw new Error('config/repos.json: unrecognised format');
}

// ---------------------------------------------------------------------------
// Format guards
// ---------------------------------------------------------------------------

interface LegacyFormat {
  repos: RepoEntry[];
}

function isNewFormat(raw: unknown): raw is ReposMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  if ('repos' in raw) return false; // legacy shape
  // Every value must be a { owner, name } entry.
  return Object.values(raw as Record<string, unknown>).every(isRepoEntry);
}

function isLegacyFormat(raw: unknown): raw is LegacyFormat {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return Array.isArray(r['repos']) && (r['repos'] as unknown[]).every(isRepoEntry);
}

function isRepoEntry(v: unknown): v is RepoEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['owner'] === 'string' &&
    typeof (v as Record<string, unknown>)['name'] === 'string'
  );
}
