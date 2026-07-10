import { stat } from 'node:fs/promises';

/**
 * Returns true if `<path>/.git` exists (directory for ordinary clones, file
 * for git worktrees). Used by `GitRepoManager` and `RepoHealthChecker` to
 * decide whether a path is a valid clone before issuing further git commands.
 */
export async function isGitDir(path: string): Promise<boolean> {
  try {
    const s = await stat(`${path}/.git`);
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
