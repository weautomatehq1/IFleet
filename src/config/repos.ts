import { readFileSync } from 'node:fs';

export interface RepoEntry {
  owner: string;
  name: string;
  /**
   * Optional allowlist of GitHub logins permitted to open `auto:ship` issues
   * for this repo. See `RepoRef.allowedAuthors` in `src/queue/types.ts` for
   * the security rationale.
   */
  allowedAuthors?: ReadonlyArray<string>;
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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to load repos config from ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r['owner'] !== 'string' || typeof r['name'] !== 'string') return false;
  if (r['allowedAuthors'] !== undefined) {
    if (!Array.isArray(r['allowedAuthors'])) return false;
    if (!r['allowedAuthors'].every((x) => typeof x === 'string')) return false;
  }
  return true;
}
