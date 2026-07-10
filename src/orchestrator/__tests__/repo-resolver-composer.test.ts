// Regression cover for AUDIT-IFleet-6126a1f9.
//
// `buildRepoResolver` composes channels.json (workDir + defaultBranch +
// codeowners) with repos.json (security allowlist). The stated invariant is
// strict: a repo must appear in BOTH files to be resolvable. Anything weaker
// reintroduces the foot-gun the audit closed.
//
// codex cross-provider review caught an earlier version where the composer
// added a backstop IFleet entry built from the daemon's cwd whenever
// channels.json didn't carry IFleet. That meant a misconfigured boot would
// silently keep dispatching to the host checkout. This test pins the
// fail-closed behavior — no IFleet, no fallback, no dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoResolver } from '../daemon';
import { FileChannelRouter } from '@wahq/orchestrator-core/repos/router';
import type { ChannelRoute } from '@wahq/orchestrator-core/contracts/channel-router';

function fakeRouter(routes: ChannelRoute[]): FileChannelRouter {
  return new FileChannelRouter(routes);
}

test('buildRepoResolver: refuses to resolve IFleet when channels.json lacks the route (no legacy cwd fallback)', () => {
  const router = fakeRouter([]); // channels.json effectively empty
  const reposMap = {
    'weautomatehq1/IFleet': {
      owner: 'weautomatehq1',
      name: 'IFleet',
    },
  };
  const resolver = buildRepoResolver(router, reposMap);

  // The audit foot-gun was: silently dispatch IFleet using the daemon cwd
  // as the worktree base. Resolve must return null instead — letting the
  // factory throw before any worktree/git/PR action.
  assert.equal(resolver.resolve('weautomatehq1/IFleet'), null);
  assert.deepEqual(resolver.list(), []);
});

test('buildRepoResolver: requires the repo in BOTH channels.json AND repos.json', () => {
  const router = fakeRouter([
    {
      channelId: '111111111111',
      repo: 'weautomatehq1/IFleet',
      workDir: '/opt/ifleet/repos/weautomatehq1-IFleet',
      defaultBranch: 'main',
      defaultModel: 'opus',
      allowedUserIds: [],
      codeowners: ['@monstersebas1'],
    },
    {
      channelId: '222222222222',
      repo: 'weautomatehq1/factory',
      workDir: '/opt/ifleet/repos/weautomatehq1-factory',
      defaultBranch: 'main',
      defaultModel: 'opus',
      allowedUserIds: [],
      codeowners: ['@monstersebas1'],
    },
  ]);
  // factory NOT in reposMap — should be rejected even though channels has it
  const reposMap = {
    'weautomatehq1/IFleet': { owner: 'weautomatehq1', name: 'IFleet' },
  };
  const resolver = buildRepoResolver(router, reposMap);

  assert.notEqual(resolver.resolve('weautomatehq1/IFleet'), null);
  assert.equal(resolver.resolve('weautomatehq1/factory'), null);
});

test('buildRepoResolver: returns the channel route fields (workDir, defaultBranch, codeowners) when both files agree', () => {
  const router = fakeRouter([
    {
      channelId: '111111111111',
      repo: 'weautomatehq1/factory',
      workDir: '/opt/ifleet/repos/weautomatehq1-factory',
      defaultBranch: 'develop',
      defaultModel: 'opus',
      allowedUserIds: [],
      codeowners: ['@monstersebas1', '@esmel'],
    },
  ]);
  const reposMap = {
    'weautomatehq1/factory': { owner: 'weautomatehq1', name: 'factory' },
  };
  const resolver = buildRepoResolver(router, reposMap);

  const resolved = resolver.resolve('weautomatehq1/factory');
  assert.notEqual(resolved, null);
  assert.equal(resolved!.repoId, 'weautomatehq1/factory');
  assert.equal(resolved!.owner, 'weautomatehq1');
  assert.equal(resolved!.name, 'factory');
  assert.equal(resolved!.repoRoot, '/opt/ifleet/repos/weautomatehq1-factory');
  assert.equal(resolved!.defaultBranch, 'develop');
  assert.deepEqual(resolved!.codeowners, ['@monstersebas1', '@esmel']);
});
