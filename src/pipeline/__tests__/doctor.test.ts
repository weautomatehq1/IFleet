import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countDoctorAttempts,
  DOCTOR_MAX_ATTEMPTS,
  parseDiagnosis,
  runDoctor,
} from '../doctor.js';
import { loadFingerprints, saveFingerprints } from '../fingerprints.js';
import type { AttemptRecord, SpawnHandle, SpawnOpts, WorkerPool, WorkerSpec } from '../types.js';

function attempt(role: AttemptRecord['role']): AttemptRecord {
  return { role, workerId: 'w', startedAt: 0, endedAt: 0, ok: true, output: '', rateLimitHits: 0 };
}

describe('doctor', () => {
  it('counts only doctor attempts', () => {
    const list = [attempt('architect'), attempt('editor'), attempt('doctor'), attempt('editor')];
    expect(countDoctorAttempts(list)).toBe(1);
  });

  it('exports a max attempts constant of 2', () => {
    expect(DOCTOR_MAX_ATTEMPTS).toBe(2);
  });

  it('parses a well-formed diagnosis', () => {
    const d = parseDiagnosis(
      '{"rootCause":"oops","proposedFix":"do x","confidence":0.7,"requiresNewBrief":false}',
    );
    expect(d.rootCause).toBe('oops');
    expect(d.confidence).toBe(0.7);
    expect(d.requiresNewBrief).toBe(false);
  });

  it('flags requiresNewBrief when JSON is malformed', () => {
    const d = parseDiagnosis('not json');
    expect(d.requiresNewBrief).toBe(true);
    expect(d.confidence).toBe(0);
  });

  it('honors requiresNewBrief:true from the model', () => {
    const d = parseDiagnosis(
      '{"rootCause":"brief wrong","proposedFix":"","confidence":0.2,"requiresNewBrief":true}',
    );
    expect(d.requiresNewBrief).toBe(true);
  });
});

describe('runDoctor fingerprint integration', () => {
  const SPEC: WorkerSpec = { provider: 'claude', model: 'opus', workerId: 'doc' };
  const CI_LOG = `TypeError: Cannot read properties of undefined (reading 'forEach')
    at handler (/repo/dist/server.js:11:1)`;

  function mockPool(captureBrief: (b: string) => void): WorkerPool {
    return {
      spawn(_spec, brief, _opts: SpawnOpts): SpawnHandle {
        captureBrief(brief);
        return {
          result: () =>
            Promise.resolve({
              ok: true,
              output:
                '{"rootCause":"r","proposedFix":"p","confidence":0.8,"requiresNewBrief":false}',
              sessionId: 's',
              rateLimitHits: 0,
            }),
          cancel: () => Promise.resolve(),
        };
      },
    };
  }

  it('records a new fingerprint when none exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-fp-'));
    const path = join(dir, '.omc/fingerprints.json');
    let seenBrief = '';
    const out = await runDoctor({
      spec: SPEC,
      workerPool: mockPool((b) => { seenBrief = b; }),
      brief: 'do x',
      plan: 'plan',
      diff: 'diff',
      ciLog: CI_LOG,
      abortSignal: new AbortController().signal,
      fingerprintsPath: path,
    });
    expect(out.fingerprint?.hash).toHaveLength(16);
    expect(out.fingerprint?.prior).toBeUndefined();
    expect(seenBrief).not.toContain('Prior fingerprint match');
    const stored = loadFingerprints(path);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(stored[out.fingerprint!.hash]?.count).toBe(1);
  });

  it('surfaces prior fix hint when fingerprint already known', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-fp-'));
    const path = join(dir, '.omc/fingerprints.json');
    // Seed the store with the hash this CI_LOG produces.
    const seed = await runDoctor({
      spec: SPEC,
      workerPool: mockPool(() => {}),
      brief: '', plan: '', diff: '', ciLog: CI_LOG,
      abortSignal: new AbortController().signal,
      fingerprintsPath: path,
    });
    const store = loadFingerprints(path);
    store[seed.fingerprint!.hash]!.last_fix_commit = 'cafef00d';
    saveFingerprints(path, store);

    let seenBrief = '';
    const second = await runDoctor({
      spec: SPEC,
      workerPool: mockPool((b) => { seenBrief = b; }),
      brief: 'do x', plan: 'plan', diff: 'diff', ciLog: CI_LOG,
      abortSignal: new AbortController().signal,
      fingerprintsPath: path,
    });
    expect(second.fingerprint?.prior?.last_fix_commit).toBe('cafef00d');
    expect(seenBrief).toContain('Prior fingerprint match');
    expect(seenBrief).toContain('cafef00d');
    const after = loadFingerprints(path);
    expect(after[second.fingerprint!.hash]?.count).toBe(2);
  });

  it('skips fingerprint logic when path is not provided', async () => {
    let seenBrief = '';
    const out = await runDoctor({
      spec: SPEC,
      workerPool: mockPool((b) => { seenBrief = b; }),
      brief: 'do x', plan: 'plan', diff: 'diff', ciLog: CI_LOG,
      abortSignal: new AbortController().signal,
    });
    expect(out.fingerprint).toBeUndefined();
    expect(seenBrief).not.toContain('Prior fingerprint match');
  });
});
