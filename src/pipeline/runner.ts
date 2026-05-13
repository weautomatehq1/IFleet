import { runArchitect } from './architect.js';
import { runEditor } from './editor.js';
import { runReviewer, assertCrossProviderRule } from './reviewer.js';
import { runDoctor, countDoctorAttempts, DOCTOR_MAX_ATTEMPTS } from './doctor.js';
import { openPipelinePr } from './pr.js';
import { appendCostRecord } from '../utils/costs.js';
import type {
  AttemptRecord,
  PipelineInput,
  PipelineResult,
  PipelineRunner,
  VerifyResult,
} from './types.js';

const DEFAULT_REVIEWER_MAX_ROUNDS = 2;

export class DefaultPipelineRunner implements PipelineRunner {
  async run(input: PipelineInput): Promise<PipelineResult> {
    const attempts: AttemptRecord[] = [];
    const baseBranch = input.baseBranch ?? 'main';
    const reviewerMaxRounds = input.reviewerMaxRounds ?? DEFAULT_REVIEWER_MAX_ROUNDS;
    const approver = input.approver ?? '@monstersebas1';

    try {
      assertCrossProviderRule(input.routing.editor, input.routing.reviewer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failed(attempts, message);
    }

    if (input.abortSignal.aborted) return cancelled(attempts);

    // === Architect ===
    const architect = await runArchitect({
      task: input.task,
      workerPool: input.workerPool,
      spec: input.routing.architect,
      issues: input.issues,
      abortSignal: input.abortSignal,
      approver,
    });
    attempts.push(architect.attempt);

    if (!architect.attempt.ok) {
      return failed(attempts, 'architect failed');
    }
    if (!architect.approved) {
      if (input.abortSignal.aborted) return cancelled(attempts);
      return failed(attempts, 'architect plan not approved');
    }
    if (input.abortSignal.aborted) return cancelled(attempts);

    const plan = architect.plan;
    const planSummary = extractSummary(plan);

    // === Editor (initial) + verify loop with doctor ===
    let diff = '';
    let lastVerify: VerifyResult | null = null;

    {
      const editor = await runEditor({
        spec: input.routing.editor,
        workerPool: input.workerPool,
        git: input.git,
        worktreePath: input.worktreePath,
        baseBranch,
        abortSignal: input.abortSignal,
        mode: { kind: 'initial', plan, brief: input.task.body },
      });
      attempts.push(editor.attempt);
      if (!editor.attempt.ok) return failed(attempts, 'editor failed');
      diff = editor.diff;
    }

    if (input.abortSignal.aborted) return cancelled(attempts);

    // Verify + doctor cycles (max 2 doctor invocations per task)
    while (true) {
      const verifyResult = await input.verify.run(input.worktreePath, input.routing.verify);
      lastVerify = verifyResult;
      if (verifyResult.ok) break;
      if (input.abortSignal.aborted) return cancelled(attempts);

      const doctorAttempts = countDoctorAttempts(attempts);
      const doctorCap = input.doctorMaxAttempts ?? DOCTOR_MAX_ATTEMPTS;
      if (doctorAttempts >= doctorCap) {
        return failed(attempts, 'doctor retry limit exceeded');
      }

      const ciLog = verifyResult.failures.map((f) => `[${f.kind}]\n${f.log}`).join('\n\n');
      const doctor = await runDoctor({
        spec: input.routing.architect,
        workerPool: input.workerPool,
        brief: input.task.body,
        plan,
        diff,
        ciLog,
        abortSignal: input.abortSignal,
      });
      attempts.push(doctor.attempt);
      if (!doctor.attempt.ok) return failed(attempts, 'doctor invocation failed');
      if (doctor.diagnosis.requiresNewBrief) {
        return failed(attempts, 'doctor requires new brief — escalating');
      }
      if (input.abortSignal.aborted) return cancelled(attempts);

      const editorRetry = await runEditor({
        spec: input.routing.editor,
        workerPool: input.workerPool,
        git: input.git,
        worktreePath: input.worktreePath,
        baseBranch,
        abortSignal: input.abortSignal,
        mode: {
          kind: 'fix_ci',
          plan,
          brief: input.task.body,
          doctorOutput: doctor.diagnosis.raw,
        },
      });
      attempts.push(editorRetry.attempt);
      if (!editorRetry.attempt.ok) return failed(attempts, 'editor retry failed');
      diff = editorRetry.diff;
      if (input.abortSignal.aborted) return cancelled(attempts);
    }

    // === Reviewer (with fix-pass loop) ===
    let reviewSummary = '';
    let approved = false;
    for (let round = 1; round <= reviewerMaxRounds; round++) {
      if (input.abortSignal.aborted) return cancelled(attempts);
      const reviewer = await runReviewer({
        editorSpec: input.routing.editor,
        reviewerSpec: input.routing.reviewer,
        workerPool: input.workerPool,
        brief: input.task.body,
        plan,
        diff,
        abortSignal: input.abortSignal,
      });
      attempts.push(reviewer.attempt);
      reviewSummary = formatReviewSummary(reviewer.verdict.verdict, reviewer.verdict.concerns);

      if (reviewer.verdict.verdict === 'approve') {
        approved = true;
        break;
      }

      if (round >= reviewerMaxRounds) break;

      if (input.abortSignal.aborted) return cancelled(attempts);
      const editorFix = await runEditor({
        spec: input.routing.editor,
        workerPool: input.workerPool,
        git: input.git,
        worktreePath: input.worktreePath,
        baseBranch,
        abortSignal: input.abortSignal,
        mode: {
          kind: 'fix_review',
          plan,
          brief: input.task.body,
          concerns: reviewer.verdict.concerns,
        },
      });
      attempts.push(editorFix.attempt);
      if (!editorFix.attempt.ok) return failed(attempts, 'editor fix-pass failed');
      diff = editorFix.diff;

      // Re-verify after the fix pass.
      const verifyAfterFix = await input.verify.run(input.worktreePath, input.routing.verify);
      lastVerify = verifyAfterFix;
      if (!verifyAfterFix.ok) {
        return failed(attempts, 'verify failed after reviewer fix-pass');
      }
    }

    if (!approved) {
      return {
        status: 'blocked_by_reviewer',
        attempts,
        planSummary,
        reviewSummary,
      };
    }

    if (input.abortSignal.aborted) return cancelled(attempts);

    // Sanity: verify must have passed before we got here.
    if (!lastVerify || !lastVerify.ok) {
      return failed(attempts, 'verify did not pass before PR open');
    }

    // === Open PR ===
    const opened = await openPipelinePr({
      task: input.task,
      worktreePath: input.worktreePath,
      baseBranch,
      pr: input.pr,
      git: input.git,
      codeowners: input.codeowners,
      planSummary,
      reviewSummary,
      editorSpec: input.routing.editor,
      reviewerSpec: input.routing.reviewer,
    });

    const result: PipelineResult = {
      status: 'pr_opened',
      prUrl: opened.url,
      attempts,
      planSummary,
      reviewSummary,
    };
    await logCosts(input, attempts);
    return result;
  }
}

async function logCosts(input: PipelineInput, attempts: AttemptRecord[]): Promise<void> {
  if (!input.repoRoot) return;
  const sprintId = input.sprintId ?? input.task.id;
  const roleSpec: Record<string, { model: string; provider: string }> = {
    architect: input.routing.architect,
    editor: input.routing.editor,
    reviewer: input.routing.reviewer,
    doctor: input.routing.architect,
  };
  for (const attempt of attempts) {
    const spec = roleSpec[attempt.role];
    if (!spec) continue;
    await appendCostRecord(input.repoRoot, {
      sprintId,
      taskId: input.task.id,
      role: attempt.role,
      model: spec.model,
      provider: spec.provider as 'claude' | 'codex',
      totalCostUsd: 0,
      durationMs: attempt.endedAt - attempt.startedAt,
      startedAt: new Date(attempt.startedAt).toISOString(),
      worktreePath: input.worktreePath,
    }).catch(() => {}); // never let cost logging break the pipeline
  }
}

function failed(attempts: AttemptRecord[], reason: string): PipelineResult {
  return { status: 'failed', attempts, failureReason: reason };
}

function cancelled(attempts: AttemptRecord[]): PipelineResult {
  return { status: 'cancelled', attempts };
}

function extractSummary(plan: string): string {
  // Architect prompt ends with a one-paragraph plain-English summary.
  // Best effort: take the last non-empty paragraph.
  const paragraphs = plan
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paragraphs.length > 0 ? (paragraphs[paragraphs.length - 1] ?? '') : plan;
}

function formatReviewSummary(verdict: 'approve' | 'request_changes', concerns: string[]): string {
  if (verdict === 'approve') return 'Reviewer approved.';
  if (concerns.length === 0) return 'Reviewer requested changes (no concerns provided).';
  return ['Reviewer requested changes:', ...concerns.map((c, i) => `${i + 1}. ${c}`)].join('\n');
}
