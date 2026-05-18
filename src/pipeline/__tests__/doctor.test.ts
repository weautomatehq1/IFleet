import { describe, it, expect } from 'vitest';
import { countDoctorAttempts, DOCTOR_MAX_ATTEMPTS, parseDiagnosis } from '../doctor.js';
import type { AttemptRecord } from '../types.js';

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
