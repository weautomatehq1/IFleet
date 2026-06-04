// Regression cover for AUDIT-IFleet-a394a4f1.
//
// The Claude Max-plan single-seat policy (rule #1 in CLAUDE.md) must hold
// even when a future operator edits `config/workers.json`. Config-only
// enforcement is brittle — a stray `maxConcurrent: 3` would silently burn the
// shared nightly quota because `SprintManager.checkBudget` intentionally
// bypasses the BUDGET_USD cap for Max-plan workers (per-call USD numbers on
// a Max subscription are not real spend).
//
// `validateMaxPlanConcurrency` throws at config-load time. Both the
// bootstrap path (`loadInitialWorkers` in `daemon.ts`) and the watcher path
// (`WorkerRegistry.loadFromDisk`) call it, so the only way to run >1 Max
// session is to delete the validation, which a code review will catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMaxPlanConcurrency, WorkerRegistry } from '../workers';
import type { WorkerConfig } from '../types';

test('validateMaxPlanConcurrency: rejects tier=max-100 with maxConcurrent > 1', () => {
  const cfg: WorkerConfig = {
    id: 'claude-max-1',
    provider: 'claude',
    tier: 'max-100',
    maxConcurrent: 2,
    enabled: true,
  };
  assert.throws(
    () => validateMaxPlanConcurrency([cfg]),
    /single-seat policy.*AUDIT-IFleet-a394a4f1/,
  );
});

test('validateMaxPlanConcurrency: rejects any max-* prefix (max-200 with maxConcurrent=5)', () => {
  const cfg: WorkerConfig = {
    id: 'claude-max-pro',
    provider: 'claude',
    tier: 'max-200',
    maxConcurrent: 5,
    enabled: true,
  };
  assert.throws(() => validateMaxPlanConcurrency([cfg]), /maxConcurrent=5/);
});

test('validateMaxPlanConcurrency: accepts tier=max-100 with maxConcurrent=1', () => {
  const cfg: WorkerConfig = {
    id: 'claude-max-1',
    provider: 'claude',
    tier: 'max-100',
    maxConcurrent: 1,
    enabled: true,
  };
  assert.doesNotThrow(() => validateMaxPlanConcurrency([cfg]));
});

test('validateMaxPlanConcurrency: accepts API-tier workers with maxConcurrent > 1 (real billing applies)', () => {
  const cfg: WorkerConfig = {
    id: 'claude-api-1',
    provider: 'claude',
    tier: 'api',
    authProfile: 'api',
    maxConcurrent: 3,
    enabled: true,
  };
  assert.doesNotThrow(() => validateMaxPlanConcurrency([cfg]));
});

test('validateMaxPlanConcurrency: accepts workers with no tier set (legacy/test fixtures)', () => {
  const cfg: WorkerConfig = {
    id: 'w1',
    provider: 'claude',
    maxConcurrent: 4,
    enabled: true,
  };
  assert.doesNotThrow(() => validateMaxPlanConcurrency([cfg]));
});

test('WorkerRegistry boots with zero workers when config violates the Max policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-workers-validation-'));
  const configPath = join(dir, 'workers.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      workers: [
        {
          id: 'claude-max-1',
          provider: 'claude',
          tier: 'max-100',
          maxConcurrent: 3,
          enabled: true,
        },
      ],
    }),
  );
  // loadFromDisk catches the validation throw and falls back to zero
  // workers (matching its existing "config unreadable" behavior). The
  // operator sees the warning in stderr and the orchestrator refuses to
  // dispatch — that's the failure mode we want, not a silent boot.
  try {
    const reg = new WorkerRegistry({ configPath, watchFs: false });
    assert.deepEqual(reg.all(), []);
    reg.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadInitialWorkers throws (does NOT fall back to env defaults) on Max policy violation', async () => {
  // codex review caught: the previous version had the validation throw
  // inside the read-file try/catch, so a violating config was silently
  // turned into the hardcoded env-fallback defaults — masking the
  // operator's intent. This test pins the fail-loud behavior.
  const { loadInitialWorkers } = await import('../daemon');
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-bootstrap-validation-'));
  const configPath = join(dir, 'workers.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      workers: [
        {
          id: 'claude-max-1',
          provider: 'claude',
          tier: 'max-100',
          maxConcurrent: 3,
          enabled: true,
        },
      ],
    }),
  );
  try {
    assert.throws(() => loadInitialWorkers(configPath), /single-seat policy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkerRegistry honors a compliant config (maxConcurrent: 1 for tier=max-*)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifleet-workers-validation-'));
  const configPath = join(dir, 'workers.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      workers: [
        {
          id: 'claude-max-1',
          provider: 'claude',
          tier: 'max-100',
          maxConcurrent: 1,
          enabled: true,
        },
      ],
    }),
  );
  try {
    const reg = new WorkerRegistry({ configPath, watchFs: false });
    assert.equal(reg.all().length, 1);
    assert.equal(reg.all()[0]?.id, 'claude-max-1');
    reg.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
