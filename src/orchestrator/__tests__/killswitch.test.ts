import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../index';
import { MockAdapter, noopBriefLoader } from './helpers';

test('kill switch: cancel.flag triggers sprint cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-kill-'));
  const dbPath = join(dir, 'state.db');
  const workersConfig = join(dir, 'workers.json');
  writeFileSync(
    workersConfig,
    JSON.stringify({
      workers: [{ id: 'w1', provider: 'claude', maxConcurrent: 1, enabled: true }],
    }),
  );
  const killDir = join(dir, 'sprints');
  const adapter = new MockAdapter({ controllable: true });

  const orch = new Orchestrator({
    adapter,
    briefLoader: noopBriefLoader,
    dbPath,
    workersConfigPath: workersConfig,
    killFlagDir: killDir,
    tickIntervalMs: 50,
    killPollIntervalMs: 50,
  });

  try {
    const rec = orch.submitSprint({
      mode: 'normal',
      goal: 'killtest',
      newTaskBriefs: ['task-a'],
    });

    orch.start();
    await new Promise((r) => setTimeout(r, 120));

    const sprintFlagDir = join(killDir, rec.id);
    mkdirSync(sprintFlagDir, { recursive: true });
    writeFileSync(join(sprintFlagDir, 'cancel.flag'), 'cancel');

    await new Promise((r) => setTimeout(r, 200));

    const after = orch.getSprint(rec.id);
    assert.equal(after?.state.kind, 'cancelled');
  } finally {
    await orch.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
