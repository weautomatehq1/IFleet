// Shared git-environment isolation for tests that shell out to `git`.
//
// WHY THIS EXISTS (AUDIT-IFleet-43254bcf and its follow-up):
// The husky `pre-push` hook runs the full test suite via `git push`. `git push`
// exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_PREFIX / … into the
// hook's environment. Those inherited variables OVERRIDE a child `git`
// process's `-C <path>` / `cwd` repo discovery — so a test's `git init` /
// `git config` / `git add` / `git commit` against a tmpdir silently operates on
// the HOST repo's `.git` instead of the tmpdir.
//
// Observed damage from that leak:
//   - empty `init` commits landing on the checked-out branch
//     (repo-resolver's `git commit --allow-empty -m init`),
//   - the host repo's `core.bare` getting flipped to `true`,
//   - the working tree getting wiped when a fixture staged `-A` against
//     GIT_WORK_TREE=<host> and committed.
//
// Before this module the scrubbing logic was copy-pasted across six test files
// in four slightly different forms — one missing entirely, one partial (only
// GIT_DIR/GIT_WORK_TREE). That drift IS how the leak survived. Every test that
// shells out to git must route through here so there is a single source of
// truth.

import { join } from 'node:path';

/**
 * A snapshot of `process.env` with every `GIT_*` variable removed.
 *
 * Pass as the `env` of any spawned `git` process so inherited hook variables
 * cannot override the intended `cwd` / `-C <path>` repo discovery. Captured
 * once at module load; do not mutate.
 */
export const cleanGitEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

export interface GitIdentity {
  name?: string;
  email?: string;
}

/**
 * Fully isolated git environment for a throwaway repo rooted under
 * `scratchDir`. Builds on {@link cleanGitEnv} and additionally:
 *   - pins a deterministic author/committer identity (override via `identity`)
 *     so the test does not depend on the host's `user.name` / `user.email`;
 *   - points `GIT_CONFIG_GLOBAL` at a scratch path and `GIT_CONFIG_SYSTEM` at
 *     `/dev/null`, so the test never reads or writes `~/.gitconfig` or
 *     `/etc/gitconfig`.
 *
 * `GIT_DIR` / `GIT_WORK_TREE` are intentionally NOT set here: `git init <path>`
 * plus an explicit `cwd` / `-C` scopes resolution to the tmpdir, and pre-setting
 * them would clash with `git init`.
 */
export function isolatedGitEnv(
  scratchDir: string,
  identity: GitIdentity = {},
): NodeJS.ProcessEnv {
  const name = identity.name ?? 'test';
  const email = identity.email ?? 'test@example.com';
  return {
    ...cleanGitEnv,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_GLOBAL: join(scratchDir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}
