#!/usr/bin/env tsx
// One-shot script: push local .audits/index.json findings to Supabase.
// Run after any local /audit-scan to make findings visible to the VPS Discord bot.
//
// Usage:
//   pnpm tsx scripts/sync-audit-findings.ts [path/to/.audits/index.json]
//
// Defaults to <repo-root>/.audits/index.json when no path is given.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbUpsertFindings } from '../src/audit/audit-store.js';
import type { AuditFinding } from '../src/discord/audit-runner.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const indexPath = process.argv[2] ?? join(repoRoot, '.audits', 'index.json');

let parsed: { repo: string; findings: AuditFinding[] };
try {
  parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as typeof parsed;
} catch (err) {
  console.error(`Cannot read ${indexPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const { repo, findings } = parsed;
if (!repo) {
  console.warn(`[audit-sync] index.json "repo" field is empty or missing — upsert may target wrong repo`);
}
const active = findings.filter((f) => f.status !== 'closed');

console.log(`Syncing ${active.length} active findings for repo "${repo}" to Supabase…`);

await dbUpsertFindings(active, repo);

console.log(`Done. ${active.length} findings upserted (duplicates skipped by fingerprint).`);
