#!/usr/bin/env node
// One-shot migration: convert .audits/index.json from nested audits[].open_findings[]
// to the canonical flat findings[] shape (canonical-pattern §5.3).
//
// Idempotent: exits 0 with "already flat" if top-level findings[] is present.
// Atomic: writes to a temp file then renames to prevent partial writes.
//
// Usage: node scripts/migrate-audits-flat.mjs [path-to-index.json]
//   Default path: <repo-root>/.audits/index.json

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const indexPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO_ROOT, '.audits', 'index.json');

if (!existsSync(indexPath)) {
  console.error(`migrate-audits-flat: file not found: ${indexPath}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(indexPath, 'utf8');
} catch (err) {
  console.error(`migrate-audits-flat: cannot read ${indexPath}: ${err.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`migrate-audits-flat: ${indexPath} is not valid JSON: ${err.message}`);
  process.exit(1);
}

// --- Idempotency check ---
if (Array.isArray(parsed.findings)) {
  console.log(`migrate-audits-flat: already flat — top-level findings[] present in ${indexPath}`);
  process.exit(0);
}

// --- Nested shape check ---
if (!Array.isArray(parsed.audits)) {
  console.error(
    `migrate-audits-flat: unexpected shape — no top-level findings[] and no audits[] in ${indexPath}`,
  );
  process.exit(1);
}

// --- Flatten ---
const findings = [];
for (const audit of parsed.audits) {
  const scanMeta = {
    audit_id: audit.audit_id ?? null,
    scanned_at: audit.scanned_at ?? null,
    branch: audit.branch ?? null,
  };

  for (const section of ['open_findings', 'fixed_findings']) {
    const arr = audit[section];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      findings.push({ ...f, scan_metadata: scanMeta });
    }
  }
}

// Determine top-level rollup from the flattened findings
const bySeverity = { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 };
let openCount = 0;
for (const f of findings) {
  if (f.status === 'open' || f.status === 'reopened') {
    openCount++;
    const sev = f.severity;
    if (sev in bySeverity) bySeverity[sev]++;
  }
}

const flat = {
  repo: parsed.repo ?? 'IFleet',
  last_updated: parsed.last_updated ?? new Date().toISOString(),
  open_findings: openCount,
  by_severity: bySeverity,
  findings,
};

// --- Atomic write ---
const dir = dirname(indexPath);
const tmp = join(dir, `.index.json.tmp-migrate-${process.pid}-${Date.now()}`);
try {
  writeFileSync(tmp, `${JSON.stringify(flat, null, 2)}\n`, 'utf8');
  renameSync(tmp, indexPath);
} catch (err) {
  console.error(`migrate-audits-flat: write failed: ${err.message}`);
  process.exit(1);
}

console.log(
  `migrate-audits-flat: migrated ${parsed.audits.length} audit(s) → ${findings.length} finding(s) in ${indexPath}`,
);
