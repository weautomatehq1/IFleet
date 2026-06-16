#!/usr/bin/env node
/**
 * Build reviewer preference cards from the `pr_decisions` history (M4-T3).
 *
 * Runs nightly (or on demand) to refresh `.ifleet/prefs/<reviewer>.json` for
 * the top-N most active reviewers in the rolling window. Idempotent: re-running
 * with the same DB produces the same JSON bytes modulo the `reviewed_at`
 * timestamp.
 *
 * Usage:
 *   pnpm tsx scripts/build-reviewer-cards.ts \
 *     [--db state/tasks.db] \
 *     [--out .ifleet/prefs] \
 *     [--window 30] \
 *     [--top 3] \
 *     [--repo weautomatehq1/IFleet] \
 *     [--quiet]
 */
import { isMainModule } from './lib/is-main-module.js';
import { buildReviewerCards, defaultPrefsDir } from '../src/learning/reviewer-prefs/index.ts';

interface CliArgs {
  db?: string;
  out: string;
  windowDays: number;
  topN: number;
  repo?: string;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let db: string | undefined;
  let out = defaultPrefsDir();
  let windowDays = 30;
  let topN = 3;
  let repo: string | undefined;
  let quiet = false;

  const need = (flag: string, value: string | undefined): string => {
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') db = need('--db', argv[++i]);
    else if (arg === '--out') out = need('--out', argv[++i]);
    else if (arg === '--window') windowDays = Number(need('--window', argv[++i]));
    else if (arg === '--top') topN = Number(need('--top', argv[++i]));
    else if (arg === '--repo') repo = need('--repo', argv[++i]);
    else if (arg === '--quiet') quiet = true;
    else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error('--window must be a positive number of days');
  }
  if (!Number.isFinite(topN) || topN <= 0) {
    throw new Error('--top must be a positive integer');
  }
  return { ...(db ? { db } : {}), out, windowDays, topN, ...(repo ? { repo } : {}), quiet };
}

function printUsage(): void {
  process.stdout.write(
    `Usage: build-reviewer-cards [--db PATH] [--out PATH] [--window 30] [--top 3] [--repo OWNER/NAME] [--quiet]\n`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = buildReviewerCards({
    ...(args.db ? { dbPath: args.db } : {}),
    outDir: args.out,
    windowDays: args.windowDays,
    topN: args.topN,
    ...(args.repo ? { repo: args.repo } : {}),
  });

  if (!args.quiet) {
    process.stdout.write(
      JSON.stringify(
        {
          reviewerCount: result.reviewerCount,
          consideredRows: result.consideredRows,
          windowDays: args.windowDays,
          topN: args.topN,
          paths: result.paths,
          cards: result.cards.map((c) => ({
            reviewer: c.reviewer,
            stats: c.stats,
          })),
        },
        null,
        2,
      ) + '\n',
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
