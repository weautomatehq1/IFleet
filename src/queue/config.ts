import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RepoConfig, RepoRef } from './types.js';

const DEFAULT_PATH = 'config/repos.json';

export async function loadRepoConfig(path: string = DEFAULT_PATH): Promise<RepoConfig> {
  const abs = resolve(process.cwd(), path);
  const raw = await readFile(abs, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}

export function validateConfig(value: unknown): RepoConfig {
  if (!isRecord(value) || !Array.isArray(value.repos)) {
    throw new Error('repos.json must be an object with a repos array');
  }
  const repos: RepoRef[] = value.repos.map((entry, idx) => {
    if (!isRecord(entry) || typeof entry.owner !== 'string' || typeof entry.name !== 'string') {
      throw new Error(`repos.json entry [${idx}] must have string owner and name`);
    }
    return { owner: entry.owner, name: entry.name };
  });
  return { repos };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
