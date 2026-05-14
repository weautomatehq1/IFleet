import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, startOrchestrator } from '../index';
import { StateStore } from '../store';
import { WorkerRegistry } from '../workers';
import { DEFAULT_REPO_ID } from '../../config/repos';
import { MockAdapter, noopBriefLoader } from './helpers';

interface Fixture {
  dir: string;
  store: StateStore;
  registry: WorkerRegistry;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-repos-'));
  const dbPath = join(dir, 'state.db');
  const workersConfig = join(dir, 'workers.json');
  writeFileSync(
    workersConfig,
    JSON.stringify({
      workers: [{ id: 'w1', provider: 'claude', maxConcurrent: 1, enabled: true }],
    }),
  );
  const store = new StateStore(dbPath);
  const registry = new WorkerRegistry({ configPath: workersConfig, watchFs: false });
  return {
    dir,
    store,
    registry,
    cleanup: () => {
      registry.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Orchestrator.getRepoId: falls back to DEFAULT_REPO_ID when nothing set', () => {
  const f = makeFixture();
  const orch = new Orchestrator({
    adapter: new MockAdapter(),
    briefLoader: noopBriefLoader,
    store: f.store,
    registry: f.registry,
  });
  try {
    assert.equal(orch.getRepoId(), DEFAULT_REPO_ID);
  } finally {
    f.cleanup();
  }
});

test('Orchestrator.getRepoId: prefers explicit repoId over reposConfig', () => {
  const f = makeFixture();
  const orch = new Orchestrator({
    adapter: new MockAdapter(),
    briefLoader: noopBriefLoader,
    store: f.store,
    registry: f.registry,
    repoId: 'explicit/wins',
    reposConfig: { 'first/key': { owner: 'first', name: 'key' } },
  });
  try {
    assert.equal(orch.getRepoId(), 'explicit/wins');
  } finally {
    f.cleanup();
  }
});

test('Orchestrator.getRepoId: uses reposConfig first key when no repoId set', () => {
  const f = makeFixture();
  const orch = new Orchestrator({
    adapter: new MockAdapter(),
    briefLoader: noopBriefLoader,
    store: f.store,
    registry: f.registry,
    reposConfig: {
      'acme/widgets': { owner: 'acme', name: 'widgets' },
      'second/repo': { owner: 'second', name: 'repo' },
    },
  });
  try {
    assert.equal(orch.getRepoId(), 'acme/widgets');
  } finally {
    f.cleanup();
  }
});

test('startOrchestrator: loads config/repos.json and wires it into the Orchestrator', () => {
  const f = makeFixture();
  const reposConfigPath = join(f.dir, 'repos.json');
  writeFileSync(
    reposConfigPath,
    JSON.stringify({ 'configured/repo': { owner: 'configured', name: 'repo' } }),
  );
  const orch = startOrchestrator({
    adapter: new MockAdapter(),
    briefLoader: noopBriefLoader,
    store: f.store,
    registry: f.registry,
    repoRoot: f.dir,
    reposConfigPath,
  });
  try {
    assert.equal(orch.getRepoId(), 'configured/repo');
  } finally {
    f.cleanup();
  }
});
