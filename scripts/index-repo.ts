#!/usr/bin/env node
/**
 * Cold-start indexer CLI. Walks a local checkout, hands TS/TSX files to the
 * IndexerAgent. Used for M3.W1 smoke tests and manual debugging.
 *
 * Usage:
 *   pnpm graph:index <repoId> <pathToCheckout>
 *     repoId           — e.g. "weautomatehq1/IFleet"
 *     pathToCheckout   — local directory; uses git to resolve the SHA
 *
 * The SHA is resolved via `git rev-parse HEAD` in the checkout. Pass an
 * absolute path or the cwd's relative path. The script refuses paths that
 * are not git repos so we never index stale snapshots.
 */

import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { IndexerAgent } from '../src/agents/indexer/index.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.pnpm-store',
]);

async function main(): Promise<void> {
  const [, , repoIdArg, pathArg] = process.argv;
  if (!repoIdArg || !pathArg) {
    console.error('Usage: pnpm graph:index <repoId> <pathToCheckout>');
    process.exitCode = 2;
    return;
  }
  const repoRoot = resolve(pathArg);
  const sha = resolveSha(repoRoot);
  const files = await walkTypeScript(repoRoot);
  console.error(`[graph:index] ${repoIdArg} @ ${sha.slice(0, 7)} — ${files.length} TS/TSX files`);

  const agent = new IndexerAgent();
  const loaded = await Promise.all(
    files.map(async path => ({
      path: relative(repoRoot, path),
      source: await readFile(path, 'utf8'),
    })),
  );
  const result = await agent.upsertRepo(repoIdArg, sha, loaded);
  console.log(JSON.stringify(result, null, 2));
}

function resolveSha(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not resolve git SHA in ${repoRoot}: ${msg}`);
  }
}

async function walkTypeScript(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await visit(full);
      } else if (s.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
        // Skip declaration files — they add nodes without behavior we care about.
        if (full.endsWith('.d.ts')) continue;
        out.push(full);
      }
    }
  }
  await visit(root);
  return out.sort();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
