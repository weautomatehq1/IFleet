// M6 — shadow-eval CLI entry point.
//
// Substrate-only wiring: the architect + verifier seams are PASSTHROUGH
// stubs that echo the row's recorded values back, so every row PASSes
// out of the box. This proves the harness pipeline end-to-end. M6
// closure (separate sprint) swaps these stubs for adapters that call
// `src/agents/architect/` + `src/agents/verifier/` for real, at which
// point the harness becomes a real regression signal.
//
// Usage:
//   node --import tsx src/agents/shadow-eval/cli.ts \
//     [--eval-set <path>] [--out <jsonl>]
//
// Defaults: --eval-set=.ifleet/eval/eval-set.jsonl, --out=stdout.
// Pretty summary always goes to stderr so stdout stays valid JSONL.

import { writeFile } from 'node:fs/promises';

import { runShadowEval } from './harness.js';
import type { ArchitectSeam, VerifierSeam } from './replay.js';
import type { EvalRow } from './types.js';

const DEFAULT_EVAL_SET = '.ifleet/eval/eval-set.jsonl';

interface CliArgs {
  evalSet: string;
  out: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  let evalSet = DEFAULT_EVAL_SET;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--eval-set') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--eval-set requires a path argument');
      evalSet = next;
      i += 1;
    } else if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--out requires a path argument');
      out = next;
      i += 1;
    }
  }
  return { evalSet, out };
}

/**
 * Substrate-only architect stub: echoes the row's recorded plan.
 * Replace in M6 closure with a real architect adapter.
 */
const passthroughArchitect: ArchitectSeam = {
  async plan(row: EvalRow) {
    return {
      filesChanged: row.files_changed,
      classifierLabel: row.classifier_label_actual,
    };
  },
};

/**
 * Substrate-only verifier stub: echoes the row's recorded merge
 * decision. Replace in M6 closure with a real verifier adapter.
 */
const passthroughVerifier: VerifierSeam = {
  async verify(_plan, row: EvalRow) {
    return { mergeDecision: row.merge_decision };
  },
};

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  const summary = await runShadowEval({
    evalSetPath: args.evalSet,
    replayDeps: {
      architect: passthroughArchitect,
      verifier: passthroughVerifier,
    },
  });

  const jsonl = summary.results.map((r) => JSON.stringify(r)).join('\n');
  if (args.out === null) {
    process.stdout.write(jsonl + (jsonl === '' ? '' : '\n'));
  } else {
    await writeFile(args.out, jsonl + (jsonl === '' ? '' : '\n'), 'utf8');
  }

  process.stderr.write(
    `[shadow-eval] total=${summary.total} passed=${summary.passed} failed=${summary.failed} ` +
      `startedAt=${summary.runStartedAt} finishedAt=${summary.runFinishedAt}\n`,
  );

  return summary.failed === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1]?.endsWith('shadow-eval/cli.ts') === true;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `[shadow-eval] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}
