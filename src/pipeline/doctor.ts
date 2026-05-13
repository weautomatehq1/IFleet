import type {
  AttemptRecord,
  DoctorDiagnosis,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { DOCTOR_SYSTEM_PROMPT } from './prompts.js';

export interface RunDoctorInput {
  spec: WorkerSpec;
  workerPool: WorkerPool;
  brief: string;
  plan: string;
  diff: string;
  ciLog: string;
  abortSignal: AbortSignal;
}

export interface DoctorOutput {
  attempt: AttemptRecord;
  diagnosis: DoctorDiagnosis;
}

export const DOCTOR_MAX_ATTEMPTS = 2;

export function countDoctorAttempts(attempts: AttemptRecord[]): number {
  return attempts.filter((a) => a.role === 'doctor').length;
}

export async function runDoctor(input: RunDoctorInput): Promise<DoctorOutput> {
  // CI log is NEVER truncated — the doctor needs the full failure context.
  const brief = [
    '## Original brief',
    input.brief,
    '',
    '## Architect plan',
    input.plan,
    '',
    '## Editor diff',
    '```diff',
    input.diff,
    '```',
    '',
    '## CI failure log (full, untruncated)',
    '```',
    input.ciLog,
    '```',
  ].join('\n');

  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.spec, brief, {
    role: 'doctor',
    systemPrompt: DOCTOR_SYSTEM_PROMPT,
    abortSignal: input.abortSignal,
  });
  const result = await handle.result();
  const endedAt = Date.now();

  const diagnosis = parseDiagnosis(result.output);

  return {
    attempt: {
      role: 'doctor',
      workerId: input.spec.workerId,
      startedAt,
      endedAt,
      ok: result.ok,
      output: result.output,
      rateLimitHits: result.rateLimitHits,
    },
    diagnosis,
  };
}

export function parseDiagnosis(raw: string): DoctorDiagnosis {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return {
      rootCause: 'doctor returned no JSON',
      proposedFix: '',
      confidence: 0,
      requiresNewBrief: true,
      raw,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const obj = parsed as Record<string, unknown>;
    const rootCause = typeof obj.rootCause === 'string' ? obj.rootCause : '';
    const proposedFix = typeof obj.proposedFix === 'string' ? obj.proposedFix : '';
    const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
    const requiresNewBrief = obj.requiresNewBrief === true;
    return { rootCause, proposedFix, confidence, requiresNewBrief, raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      rootCause: `doctor JSON malformed: ${message}`,
      proposedFix: '',
      confidence: 0,
      requiresNewBrief: true,
      raw,
    };
  }
}
