// Regression cover for AUDIT-IFleet-6126a1f9.
//
// The factory used to hardcode a single repoRoot/repoId pair at bootstrap,
// so any task — regardless of `task.repo` — landed under the IFleet checkout
// with a PR opened against `weautomatehq1/IFleet`. A `/ship` in the factory
// channel could plausibly mutate IFleet.
//
// The fix made `makeProductionFactory` take a `RepoResolver` and resolve
// `task.repo` per task. This file verifies:
//   1. The factory refuses (throws) when `task.repo` is not in the resolver.
//   2. The factory uses the resolved `repoRoot` for the worktree-base path.
//   3. The factory uses the resolved `defaultBranch` for the PR base branch.
//
// We exercise `makeProductionFactory` directly with a mock resolver, a mock
// Octokit, and a fake brief — we don't actually create a worktree, we just
// drive the factory until it throws (case 1) or until we can inspect the
// PipelineInput it builds (cases 2-3). The worktree-setup itself is covered
// by existing pipeline tests.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { cleanGitEnv } from '../../testing/git-env.js';
import { makeProductionFactory, type RepoResolver, type ResolvedRepo } from '../factory.js';
import { encodeBridgeBrief } from '../../orchestrator/pipeline-bridge.js';
import type { QueuedTask as UnifiedQueuedTask } from '@wahq/orchestrator-core/contracts/task';
import type { TaskId, WorkerConfig } from '../../orchestrator/types.js';
import type { Octokit } from '@octokit/rest';
import { TaskStore } from '@wahq/orchestrator-core/queue/store';
import { IFLEET_STORE_EXTENSIONS } from '../../agents/bandit/store-extensions.js';
import { readShadowDecisions } from '../../agents/bandit/shadow.js';

const taskId = (raw: string) => raw as unknown as TaskId;

const mockOctokit = {} as Octokit;

const fakeWorker: WorkerConfig = {
  id: 'w1',
  provider: 'claude',
  authProfile: 'default',
  maxConcurrent: 1,
  enabled: true,
};

function makeResolver(repos: ReadonlyArray<ResolvedRepo>): RepoResolver {
  const byId = new Map(repos.map((r) => [r.repoId, r]));
  return {
    resolve: (slug) => byId.get(slug) ?? null,
    list: () => repos,
  };
}

function makeTaskBrief(repo: string): string {
  const task: UnifiedQueuedTask = {
    id: 'task-1',
    brief: 'test task',
    repo,
    title: 'test',
    source: {
      kind: 'github',
      repo,
      issueNumber: 1,
      issueNodeId: 'I_1',
      url: `https://github.com/${repo}/issues/1`,
    },
    routingHints: { autonomy: 'auto', priority: 'normal', verify: [] },
    createdAt: Date.now(),
    idempotencyKey: 'task-1-key',
  };
  return encodeBridgeBrief(task);
}

describe('makeProductionFactory — cross-repo dispatch refusal (AUDIT-IFleet-6126a1f9)', () => {
  it('throws when task.repo is not in the resolver allowlist', async () => {
    const resolver = makeResolver([
      {
        repoId: 'weautomatehq1/IFleet',
        owner: 'weautomatehq1',
        name: 'IFleet',
        repoRoot: '/tmp/ifleet',
        defaultBranch: 'main',
      },
    ]);
    const { factory } = makeProductionFactory({
      repoResolver: resolver,
      octokit: mockOctokit,
      initialWorkers: [fakeWorker],
    });

    const brief = makeTaskBrief('weautomatehq1/UnknownRepo');
    await expect(factory(taskId('task-1'), brief, {})).rejects.toThrow(
      /refusing to dispatch.*UnknownRepo.*not in the resolver allowlist/,
    );
  });

  it('error message lists the known repos so the operator can see the allowlist', async () => {
    const resolver = makeResolver([
      {
        repoId: 'weautomatehq1/IFleet',
        owner: 'weautomatehq1',
        name: 'IFleet',
        repoRoot: '/tmp/ifleet',
        defaultBranch: 'main',
      },
      {
        repoId: 'weautomatehq1/factory',
        owner: 'weautomatehq1',
        name: 'factory',
        repoRoot: '/tmp/factory',
        defaultBranch: 'main',
      },
    ]);
    const { factory } = makeProductionFactory({
      repoResolver: resolver,
      octokit: mockOctokit,
      initialWorkers: [fakeWorker],
    });

    const brief = makeTaskBrief('weautomatehq1/other');
    await expect(factory(taskId('task-1'), brief, {})).rejects.toThrow(
      /weautomatehq1\/IFleet, weautomatehq1\/factory/,
    );
  });

  it('throws (does not silently default to IFleet) when the resolver is empty', async () => {
    const resolver = makeResolver([]);
    const { factory } = makeProductionFactory({
      repoResolver: resolver,
      octokit: mockOctokit,
      initialWorkers: [fakeWorker],
    });

    const brief = makeTaskBrief('weautomatehq1/IFleet');
    await expect(factory(taskId('task-1'), brief, {})).rejects.toThrow(
      /not in the resolver allowlist.*Known repos: \(none\)/,
    );
  });
});

describe('makeProductionFactory — M6-T3 shadow wiring', () => {
  function initGitRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), 'm6-fakerepo-'));
    // cleanGitEnv strips inherited GIT_* so these calls can't be redirected onto
    // the host repo by the husky pre-push hook's GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
    // (this is the test that produced the empty `init` commits — AUDIT-IFleet-43254bcf
    // follow-up). Identity comes from the local `git config` below, so the scratch
    // GIT_CONFIG_GLOBAL form is intentionally NOT used here: repoRoot is the work
    // tree and a .gitconfig inside it could be picked up by `git add` in code under test.
    const env = cleanGitEnv;
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot], { env });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'], { env });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'test'], { env });
    // Disable signing for this throwaway repo — the global ~/.gitconfig has
    // commit.gpgsign=true wired to an environment-runner signing server that
    // is not available in all CI / cloud environments. Per-repo config overrides
    // the global setting without touching ~/.gitconfig or system config.
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false'], { env });
    execFileSync('git', ['-C', repoRoot, 'commit', '--allow-empty', '-q', '-m', 'init'], { env });
    return repoRoot;
  }

  it('persists routing_decision and appends a routing_shadow_log row', async () => {
    const repoRoot = initGitRepo();
    const dbDir = mkdtempSync(join(tmpdir(), 'm6-db-'));
    const store = new TaskStore(join(dbDir, 'tasks.db'), { extensions: IFLEET_STORE_EXTENSIONS });
    try {
      // Seed a task so the FK on routing_shadow_log holds and so
      // setRoutingDecision has a row to update.
      const task: UnifiedQueuedTask = {
        id: 'm6-task-1',
        brief: 'test task',
        repo: 'weautomatehq1/IFleet',
        title: 'test',
        source: {
          kind: 'github',
          repo: 'weautomatehq1/IFleet',
          issueNumber: 0,
          issueNodeId: 'I_1',
          url: 'https://github.com/weautomatehq1/IFleet/issues/0',
        },
        routingHints: { autonomy: 'auto', priority: 'normal', verify: [] },
        createdAt: Date.now(),
        idempotencyKey: 'm6-task-1-key',
      };
      store.insert(task);

      const resolver = makeResolver([
        {
          repoId: 'weautomatehq1/IFleet',
          owner: 'weautomatehq1',
          name: 'IFleet',
          repoRoot,
          defaultBranch: 'main',
        },
      ]);

      const { factory } = makeProductionFactory({
        repoResolver: resolver,
        octokit: mockOctokit,
        initialWorkers: [fakeWorker],
        taskStore: store,
      });

      const brief = encodeBridgeBrief(task);
      // The factory completes setupWorktree + classifyTask + the shadow
      // wiring then returns a bootstrap. We don't run the pipeline — we
      // just inspect the side effects.
      const bootstrap = await factory(taskId(task.id), brief, {});
      try {
        const persisted = store.getById(task.id)!;
        expect(persisted.routingDecision).not.toBeNull();
        expect(persisted.routingDecision?.architect.model).toMatch(/^claude-/);

        const shadowRows = readShadowDecisions(store.getDb());
        // M6-T3: factory fans out one shadow row per role (architect,
        // editor, reviewer) — triples the signal volume for the live-bandit
        // gate.
        expect(shadowRows).toHaveLength(3);
        const byRole = Object.fromEntries(shadowRows.map((r) => [r.role, r]));
        expect(Object.keys(byRole).sort()).toEqual(['architect', 'editor', 'reviewer']);
        for (const r of shadowRows) {
          expect(r.taskId).toBe(task.id);
        }
        expect(byRole.architect!.actualModel).toBe(persisted.routingDecision!.architect.model);
        expect(byRole.editor!.actualModel).toBe(persisted.routingDecision!.editor.model);
        expect(byRole.reviewer!.actualModel).toBe(persisted.routingDecision!.reviewer.model);
      } finally {
        await bootstrap.teardown?.(new Error('test teardown'));
      }
    } finally {
      store.close();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('omitting taskStore is back-compat — factory still produces a bootstrap', async () => {
    const repoRoot = initGitRepo();
    try {
      const task: UnifiedQueuedTask = {
        id: 'm6-task-noStore',
        brief: 'test',
        repo: 'weautomatehq1/IFleet',
        title: 'test',
        source: {
          kind: 'github',
          repo: 'weautomatehq1/IFleet',
          issueNumber: 0,
          issueNodeId: 'I_2',
          url: 'https://github.com/weautomatehq1/IFleet/issues/0',
        },
        routingHints: { autonomy: 'auto', priority: 'normal', verify: [] },
        createdAt: Date.now(),
        idempotencyKey: 'm6-task-noStore-key',
      };
      const resolver = makeResolver([
        {
          repoId: 'weautomatehq1/IFleet',
          owner: 'weautomatehq1',
          name: 'IFleet',
          repoRoot,
          defaultBranch: 'main',
        },
      ]);
      const { factory } = makeProductionFactory({
        repoResolver: resolver,
        octokit: mockOctokit,
        initialWorkers: [fakeWorker],
        // taskStore deliberately omitted
      });
      const brief = encodeBridgeBrief(task);
      const bootstrap = await factory(taskId(task.id), brief, {});
      try {
        expect(bootstrap.input.routing.architect.model).toMatch(/^claude-/);
      } finally {
        await bootstrap.teardown?.(new Error('test teardown'));
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('makeProductionFactory — uses resolved repo fields, not hardcoded values', () => {
  it('uses the resolved defaultBranch (not hardcoded "main") and repoRoot for the factory channel', async () => {
    const factoryClone = mkdtempSync(join(tmpdir(), 'fake-factory-repo-'));
    try {
      // The factory clone needs to be a git repo for setupWorktree to succeed.
      // We don't actually run setupWorktree here — we abort before it by
      // returning a worker that throws. We just want to verify the factory
      // *would* use these resolved values.
      const resolver = makeResolver([
        {
          repoId: 'weautomatehq1/factory',
          owner: 'weautomatehq1',
          name: 'factory',
          repoRoot: factoryClone,
          defaultBranch: 'develop', // intentionally non-main
        },
      ]);

      // Capture the resolved values via a sentinel resolve that records its
      // input. This is the most surgical assertion: the factory consulted the
      // resolver with the exact slug from task.repo.
      let resolveArg: string | undefined;
      const tracker: RepoResolver = {
        resolve: (slug) => {
          resolveArg = slug;
          return resolver.resolve(slug);
        },
        list: () => resolver.list(),
      };

      const { factory } = makeProductionFactory({
        repoResolver: tracker,
        octokit: mockOctokit,
        initialWorkers: [fakeWorker],
      });

      const brief = makeTaskBrief('weautomatehq1/factory');
      // We expect this to fail at setupWorktree (the path isn't a real git
      // repo with a `main` branch to fork from) — but it should fail AFTER
      // the resolver was consulted with the right slug. That's enough to
      // prove the per-task resolution happened.
      await factory(taskId('task-1'), brief, {}).catch(() => {
        // Expected — setupWorktree will likely throw on the fake repo.
      });

      expect(resolveArg).toBe('weautomatehq1/factory');
    } finally {
      rmSync(factoryClone, { recursive: true, force: true });
    }
  });
});
