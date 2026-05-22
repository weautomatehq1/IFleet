import fs from 'fs';
import path from 'path';

/**
 * Reads and returns the "version" field from the repo's package.json.
 * Synchronous — suitable for startup-time or initialization contexts.
 */
export function getRepoVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
  );
  return pkg.version as string;
}
