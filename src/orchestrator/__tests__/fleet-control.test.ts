import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearFleetPause,
  isFleetPaused,
  pausedFlagPath,
  readPauseInfo,
  setFleetPaused,
} from '../fleet-control.js';

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-control-'));
  return dir;
}

test('isFleetPaused returns false on a fresh root', () => {
  const root = makeRoot();
  try {
    assert.equal(isFleetPaused(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setFleetPaused → isFleetPaused → clearFleetPause round-trip', () => {
  const root = makeRoot();
  try {
    setFleetPaused({ reason: 'token burn check', by: 'sebas' }, root);
    assert.equal(isFleetPaused(root), true);
    const info = readPauseInfo(root);
    assert.equal(info.paused, true);
    assert.equal(info.by, 'sebas');
    assert.equal(info.reason, 'token burn check');
    assert.ok(info.since, 'since timestamp is set');
    clearFleetPause(root);
    assert.equal(isFleetPaused(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readPauseInfo falls back to mtime when flag file is empty (legacy fleet:pause)', () => {
  const root = makeRoot();
  try {
    // Simulate legacy `touch .omc/PAUSED` — empty file, no metadata. Call
    // setFleetPaused first so the .omc dir exists, then overwrite to empty.
    setFleetPaused({}, root);
    writeFileSync(pausedFlagPath(root), '');
    const info = readPauseInfo(root);
    assert.equal(info.paused, true);
    assert.ok(info.since, 'falls back to mtime');
    assert.equal(info.reason, undefined);
    assert.equal(info.by, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clearFleetPause is idempotent — safe to call when not paused', () => {
  const root = makeRoot();
  try {
    clearFleetPause(root);
    clearFleetPause(root);
    assert.equal(isFleetPaused(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
