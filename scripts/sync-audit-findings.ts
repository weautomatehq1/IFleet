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
import { dbUpsertFindings, normaliseAuditRepo } from '../src/audit/audit-store.js';
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
if (!repo || typeof repo !== 'string') {
  console.error(`[audit-sync] index.json "repo" field is missing or not a string — refusing to upsert (would otherwise target the wrong scope)`);
  process.exit(1);
}
if (!Array.isArray(findings)) {
  console.error(`[audit-sync] index.json "findings" field is not an array — refusing to upsert`);
  process.exit(1);
}
const active = findings.filter((f) => f.status !== 'closed');
const repoKey = normaliseAuditRepo(repo ?? '');

console.log(`Syncing ${active.length} active findings for repo "${repoKey}" to Supabase…`);

await dbUpsertFindings(active, repoKey);

console.log(`Done. ${active.length} findings upserted (duplicates skipped by fingerprint).`);

// pg pool keeps the event loop alive; exit explicitly so the script doesn't hang.
process.exit(0);
