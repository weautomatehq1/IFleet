// Standalone subprocess entry for running arch.ts invariant files.
// Spawned by InvariantRunner.runArch() with a stripped env (verifyChildEnv)
// so arch.ts cannot access daemon secrets even if the file was written by a
// jailbroken worker. (AUDIT-IFleet-5fc6ca57)
//
// Usage: node --import tsx arch-runner-process.ts <archPath> <worktreePath>
// Output: JSON to stdout — { violations: ArchViolation[] } | { error: string }

import { pathToFileURL } from 'node:url';

const [archPath, worktreePath] = process.argv.slice(2);

if (!archPath || !worktreePath) {
  process.stdout.write(
    JSON.stringify({ error: 'usage: arch-runner-process <archPath> <worktreePath>' }),
  );
  process.exit(1);
}

try {
  const mod = (await import(pathToFileURL(archPath).href)) as { default?: unknown };
  const handler = mod.default;
  if (typeof handler !== 'function') {
    process.stdout.write(
      JSON.stringify({ error: `${archPath}: default export is not a function` }),
    );
    process.exit(1);
  }
  const result = (await handler({ worktreePath })) as
    | Array<{ message?: unknown; file?: unknown; line?: unknown }>
    | void;
  process.stdout.write(
    JSON.stringify({ violations: Array.isArray(result) ? result : [] }),
  );
} catch (err) {
  process.stdout.write(
    JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
}
