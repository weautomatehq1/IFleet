import { argv } from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when the module identified by `importMetaUrl` is the process entrypoint
 * (run directly via `node`/`tsx`), false when it is imported by another module
 * (e.g. a test or another script).
 *
 * Guards top-level `main()` invocations so that importing a script for its
 * exports does not trigger its side effects — most importantly any
 * `process.exit()` call, which otherwise kills the importing process (e.g. the
 * test runner).
 *
 * Resolves symlinks and normalizes path separators on both sides so the
 * comparison holds under tsx, pnpm symlinked bins, and Windows/POSIX alike.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    return importMetaUrl === pathToFileURL(entry).href;
  }
}
