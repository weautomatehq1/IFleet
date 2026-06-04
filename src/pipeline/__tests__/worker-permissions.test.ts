// Regression cover for AUDIT-IFleet-dc95add8.
//
// The Claude worker spawns with `--permission-mode acceptEdits`, so the
// per-worktree `.claude/settings.json` is the only runtime enforcement layer
// between the worker and destructive shell operations. Prompts (in
// `src/pipeline/prompts.ts`) tell the editor not to run git or destructive
// commands, but prompt-following is not a safety guarantee.
//
// This test pins the high-risk shapes in `WORKER_CLAUDE_PERMISSIONS` so a
// future allowlist widening cannot silently restore the pre-fix posture
// (`Bash(git *)` + `Bash(rm *)` permitted at runtime).

import { describe, it, expect } from 'vitest';
import { WORKER_CLAUDE_PERMISSIONS } from '../factory.js';

describe('WORKER_CLAUDE_PERMISSIONS — destructive-command guard', () => {
  it('does not allow blanket Bash(git *), Bash(rm *), or Bash(find *)', () => {
    expect(WORKER_CLAUDE_PERMISSIONS.allow).not.toContain('Bash(git *)');
    expect(WORKER_CLAUDE_PERMISSIONS.allow).not.toContain('Bash(rm *)');
    // `Bash(git branch *)` is broad enough to permit `git branch -D` — keep
    // it out of the allow list (we whitelist `--show-current` / `--list *`
    // explicitly instead).
    expect(WORKER_CLAUDE_PERMISSIONS.allow).not.toContain('Bash(git branch *)');
    // `Bash(find *)` allows `find . -delete` and `find . -exec rm -rf {} +` —
    // a trivial destructive escape hatch. Workers use Glob/Grep for
    // read-only discovery instead.
    expect(WORKER_CLAUDE_PERMISSIONS.allow).not.toContain('Bash(find *)');
  });

  it('explicitly denies the destructive git and shell forms', () => {
    const requiredDenies = [
      'Bash(git push *)',
      'Bash(git reset *)',
      'Bash(git checkout *)',
      'Bash(git clean *)',
      'Bash(git branch -D *)',
      'Bash(git branch --delete *)',
      'Bash(git rebase *)',
      'Bash(git worktree *)',
      'Bash(rm *)',
      'Bash(rmdir *)',
      'Bash(find *)',
      'Bash(sudo *)',
      'Bash(curl *)',
      'Bash(ssh *)',
    ];
    for (const denied of requiredDenies) {
      expect(WORKER_CLAUDE_PERMISSIONS.deny).toContain(denied);
    }
  });

  it('keeps read-only git aliases the editor needs for self-checks', () => {
    const requiredReadOnlyGit = [
      'Bash(git status)',
      'Bash(git diff)',
      'Bash(git log)',
      'Bash(git show)',
    ];
    for (const allowed of requiredReadOnlyGit) {
      expect(WORKER_CLAUDE_PERMISSIONS.allow).toContain(allowed);
    }
  });
});
