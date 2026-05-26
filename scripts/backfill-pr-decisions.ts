#!/usr/bin/env node
/**
 * Backfill `pr_decisions` from a repo's historical pull requests via `gh`.
 *
 * Part of M4 (Upgrade 5 — PR rejection learning, W1 deliverable). The store API
 * lives in src/queue/store.ts; this script is the first producer that
 * populates it, ahead of the webhook handler. Pure mapping logic is isolated
 * in scripts/lib/pr-decisions-backfill.ts and unit-tested.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-pr-decisions.ts \
 *     --repo weautomatehq1/IFleet \
 *     --days 90 \
 *     [--db /path/to/tasks.db] \
 *     [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.js';
import { TaskStore, defaultTasksDbPath } from '../src/queue/store.ts';
import {
  mapPullRequests,
  type GhPullRequest,
} from './lib/pr-decisions-backfill.ts';

interface CliArgs {
  repo: string;
  days: number;
  db: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let repo: string | undefined;
  let days = 90;
  let db = defaultTasksDbPath();
  let dryRun = false;

  const need = (flag: string, value: string | undefined): string => {
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') repo = need('--repo', argv[++i]);
    else if (arg === '--days') days = Number(need('--days', argv[++i]));
    else if (arg === '--db') db = need('--db', argv[++i]);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (!repo) throw new Error('--repo <owner/name> is required');
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  return { repo, days, db, dryRun };
}

function printUsage(): void {
  process.stdout.write(
    `Usage: backfill-pr-decisions --repo <owner/name> [--days 90] [--db PATH] [--dry-run]\n`,
  );
}

function fetchPullRequests(repo: string, days: number): GhPullRequest[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const stdout = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '500',
      '--search',
      `updated:>=${since}`,
      '--json',
      'url,number,state,mergedAt,closedAt,author,reviews',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('gh pr list did not return an array');
  if (parsed.length === 500) {
    process.stderr.write(
      `warning: hit 500 PR limit for ${repo}; older PRs in the ${days}d window may be missing\n`,
    );
  }
  return parsed as GhPullRequest[];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const prs = fetchPullRequests(args.repo, args.days);
  const { mapped, skipped } = mapPullRequests(prs, args.repo);

  const summary = {
    repo: args.repo,
    days: args.days,
    fetched: prs.length,
    mapped: mapped.length,
    skipped: skipped.length,
    byVerdict: { merged: 0, rejected: 0, abandoned: 0 } as Record<string, number>,
  };
  for (const m of mapped) summary.byVerdict[m.input.verdict]! += 1;

  if (args.dryRun) {
    process.stdout.write(`[dry-run] ${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const store = new TaskStore(args.db);
  let written = 0;
  let skippedDuplicate = 0;
  try {
    // Dedupe across re-runs: `pr_decisions` has no UNIQUE(repo, pr_number),
    // so we filter against rows already on disk before inserting.
    const existing = new Set(
      store
        .getPrDecisionsByRepo(args.repo, 10_000)
        .map((d) => d.prNumber),
    );
    for (const m of mapped) {
      if (existing.has(m.input.prNumber)) {
        skippedDuplicate += 1;
        continue;
      }
      store.recordPrDecision(m.input);
      written += 1;
    }
  } finally {
    store.close();
  }

  process.stdout.write(
    `${JSON.stringify({ ...summary, written, skippedDuplicate, db: args.db }, null, 2)}\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
