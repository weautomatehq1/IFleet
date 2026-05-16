import type {
  AttemptRecord,
  GitOps,
  SprintMode,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import {
  buildEditorPrompt,
  EDITOR_DOCTOR_PROMPT_HEADER,
  EDITOR_FIX_PASS_PROMPT_HEADER,
} from './prompts.js';

export type EditorMode =
  | { kind: 'initial'; plan: string; brief: string }
  | { kind: 'fix_review'; plan: string; brief: string; concerns: string[] }
  | { kind: 'fix_ci'; plan: string; brief: string; doctorOutput: string };

export interface RunEditorInput {
  spec: WorkerSpec;
  workerPool: WorkerPool;
  git: GitOps;
  worktreePath: string;
  baseBranch: string;
  sprintMode?: SprintMode;
  abortSignal: AbortSignal;
  mode: EditorMode;
}

export interface EditorOutput {
  attempt: AttemptRecord;
  diff: string;
}

export async function runEditor(input: RunEditorInput): Promise<EditorOutput> {
  const startedAt = Date.now();
  const brief = buildBrief(input.mode);

  const handle = input.workerPool.spawn(input.spec, brief, {
    role: 'editor',
    systemPrompt: buildEditorPrompt(input.sprintMode ?? 'default'),
    worktreePath: input.worktreePath,
    abortSignal: input.abortSignal,
  });

  const result = await handle.result();
  const endedAt = Date.now();

  let diff = '';
  if (result.ok) {
    diff = await input.git.diff(input.worktreePath, input.baseBranch);
  }

  return {
    attempt: {
      role: 'editor',
      workerId: input.spec.workerId,
      startedAt,
      endedAt,
      ok: result.ok,
      output: result.output,
      rateLimitHits: result.rateLimitHits,
      ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
    },
    diff,
  };
}

function buildBrief(mode: EditorMode): string {
  switch (mode.kind) {
    case 'initial':
      return [
        '## Original brief',
        mode.brief,
        '',
        '## Architect plan',
        mode.plan,
      ].join('\n');
    case 'fix_review':
      return [
        EDITOR_FIX_PASS_PROMPT_HEADER,
        ...mode.concerns.map((c, i) => `${i + 1}. ${c}`),
        '',
        '## Original brief',
        mode.brief,
        '',
        '## Architect plan',
        mode.plan,
      ].join('\n');
    case 'fix_ci':
      return [
        EDITOR_DOCTOR_PROMPT_HEADER,
        mode.doctorOutput,
        '',
        '## Original brief',
        mode.brief,
        '',
        '## Architect plan',
        mode.plan,
      ].join('\n');
  }
}
