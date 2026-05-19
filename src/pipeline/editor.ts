import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AttemptRecord,
  GitOps,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import {
  EDITOR_DOCTOR_PROMPT_HEADER,
  EDITOR_FIX_PASS_PROMPT_HEADER,
  EDITOR_SYSTEM_PROMPT,
} from './prompts.js';

const execFileAsync = promisify(execFile);

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
    systemPrompt: EDITOR_SYSTEM_PROMPT,
    worktreePath: input.worktreePath,
    abortSignal: input.abortSignal,
  });

  const result = await handle.result();
  const endedAt = Date.now();

  let diff = '';
  if (result.ok) {
    // Commit any file changes made by the editor. The editor is instructed
    // to use only Read/Edit/Write tools — git is handled here programmatically.
    await commitEditorChanges(input.worktreePath);
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

async function commitEditorChanges(worktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  } catch (err) {
    console.warn('[pipeline] editor: git add failed:', err);
    return;
  }
  // `git diff --cached --quiet` exits 1 when there are staged changes; treat
  // that as the signal to commit rather than as an error.
  const hasChanges = await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath })
    .then(() => false)
    .catch(() => true);
  if (!hasChanges) return;
  try {
    await execFileAsync('git', ['commit', '-m', 'chore: editor changes'], { cwd: worktreePath });
  } catch (err) {
    console.warn('[pipeline] editor: git commit failed:', err);
  }
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
