import type {
  AttemptRecord,
  DoctorDiagnosis,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { DOCTOR_SYSTEM_PROMPT } from './prompts.js';
import {
  computeFingerprint,
  formatPriorFixHint,
  loadFingerprints,
  matchFingerprint,
  recordFingerprint,
  saveFingerprints,
  type Fingerprint,
} from './fingerprints.js';

export interface RunDoctorInput {
  spec: WorkerSpec;
  workerPool: WorkerPool;
  brief: string;
  plan: string;
  diff: string;
  ciLog: string;
  abortSignal: AbortSignal;
  /**
   * Optional path to `.omc/fingerprints.json`. When set, the doctor computes a
   * fingerprint from `ciLog`, surfaces any prior match as a hint inside the
   * brief, and records the new occurrence after diagnosis. Absent → behaviour
   * is unchanged from the pre-fingerprint contract.
   */
  fingerprintsPath?: string;
  /**
   * Absolute path to the per-task git worktree. The doctor is read-only by
   * intent, but we still sandbox it so an out-of-scope tool call can't touch
   * the host repo.
   */
  worktreePath?: string;
}

export interface DoctorFingerprintInfo {
  hash: string;
  tag: string;
  prior?: Fingerprint;
}

export interface DoctorOutput {
  attempt: AttemptRecord;
  diagnosis: DoctorDiagnosis;
  fingerprint?: DoctorFingerprintInfo;
}

export const DOCTOR_MAX_ATTEMPTS = 2;

export function countDoctorAttempts(attempts: AttemptRecord[]): number {
  return attempts.filter((a) => a.role === 'doctor').length;
}

export async function runDoctor(input: RunDoctorInput): Promise<DoctorOutput> {
  const fingerprint = input.fingerprintsPath
    ? lookupFingerprint(input.fingerprintsPath, input.ciLog)
    : undefined;
  const priorHint = formatPriorFixHint(fingerprint?.prior);

  // CI log is NEVER truncated — the doctor needs the full failure context.
  const briefSections: string[] = ['## Original brief', input.brief, ''];
  if (priorHint) {
    briefSections.push('## Prior fingerprint match', priorHint, '');
  }
  briefSections.push(
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
  );
  const brief = briefSections.join('\n');

  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.spec, brief, {
    role: 'doctor',
    systemPrompt: DOCTOR_SYSTEM_PROMPT,
    abortSignal: input.abortSignal,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  });
  const result = await handle.result();
  const endedAt = Date.now();

  const diagnosis = parseDiagnosis(result.output);

  if (result.ok && input.fingerprintsPath && fingerprint) {
    persistFingerprint(input.fingerprintsPath, fingerprint.hash, fingerprint.tag);
  }

  const output: DoctorOutput = {
    attempt: {
      role: 'doctor',
      workerId: input.spec.workerId,
      startedAt,
      endedAt,
      ok: result.ok,
      output: result.output,
      rateLimitHits: result.rateLimitHits,
      ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
      ...(result.totalTokens !== undefined && { totalTokens: result.totalTokens }),
    },
    diagnosis,
  };
  if (fingerprint) output.fingerprint = fingerprint;
  return output;
}

function lookupFingerprint(path: string, ciLog: string): DoctorFingerprintInfo {
  const { hash, tag } = computeFingerprint(ciLog);
  const store = loadFingerprints(path);
  const prior = matchFingerprint(store, hash);
  const info: DoctorFingerprintInfo = { hash, tag };
  if (prior) info.prior = prior;
  return info;
}

function persistFingerprint(path: string, hash: string, tag: string): void {
  const store = loadFingerprints(path);
  recordFingerprint(store, hash, tag);
  saveFingerprints(path, store);
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
