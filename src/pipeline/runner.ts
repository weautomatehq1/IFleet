import { runArchitect } from './architect.js';
import { runEditor } from './editor.js';
import { runReviewer, assertCrossProviderRule } from './diff-reviewer.js';
import {
  runPlanReviewer,
  PLAN_REVIEWER_MAX_VETOES,
  formatPlanReviewerEscalation,
  type PlanReviewVetoReason,
} from './plan-reviewer.js';
import { runDoctor, countDoctorAttempts, DOCTOR_MAX_ATTEMPTS } from './doctor.js';
import { openPipelinePr } from './pr.js';
import { appendCostRecord } from '../utils/costs.js';
import {
  extractAuditFindingId,
  markFindingClosed,
  resolveAuditIndexPath,
} from '../discord/audit-runner.js';
import type {
  AttemptRecord,
  PipelineInput,
  PipelineResult,
  PipelineRunner,
  QueuedTask,
  ReviewerVerdict,
  VerifyResult,
} from './types.js';

const DEFAULT_REVIEWER_MAX_ROUNDS = 2;

export class DefaultPipelineRunner implements PipelineRunner {
  async run(input: PipelineInput): Promise<PipelineResult> {
    const attempts: AttemptRecord[] = [];
    const baseBranch = input.baseBranch ?? 'main';
    const reviewerMaxRounds = input.reviewerMaxRounds ?? DEFAULT_REVIEWER_MAX_ROUNDS;
    const approver = input.approver ?? '@monstersebas1';

    const poolProviders = new Set([
      input.routing.architect.provider,
      input.routing.editor.provider,
      input.routing.reviewer.provider,
    ]);
    try {
      assertCrossProviderRule(input.routing.editor, input.routing.reviewer, poolProviders);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failed(attempts, message);
    }

    if (input.abortSignal.aborted) return cancelled(attempts);

    // === Architect → Plan-Reviewer loop ===
    // Architect runs at least once. If a plan-reviewer is configured and
    // vetoes the plan, architect re-runs with the veto reasons appended to
    // its brief. After PLAN_REVIEWER_MAX_VETOES vetoes, escalate.
    //
    // When `input.routing.planReviewer` is unset (M1 routing) the loop
    // breaks after one iteration and the pipeline behaves exactly as before
    // this upgrade.
    let plan = '';
    let planSummary = '';
    let architectCostUsd: number | undefined;
    const priorReasons: PlanReviewVetoReason[] = [];
    for (let planAttempt = 1; planAttempt <= PLAN_REVIEWER_MAX_VETOES; planAttempt++) {
      const taskForAttempt =
        planAttempt === 1 ? input.task : augmentTaskWithVetoReasons(input.task, priorReasons);

      console.warn(`[pipeline] architect starting (attempt ${planAttempt}) worktree=${input.worktreePath}`);
      const architect = await runArchitect({
        task: taskForAttempt,
        workerPool: input.workerPool,
        spec: input.routing.architect,
        issues: input.issues,
        abortSignal: input.abortSignal,
        approver,
        ...(input.approvalGate ? { approvalGate: input.approvalGate } : {}),
        ...(input.onArchitectPlan ? { onPlanReady: input.onArchitectPlan } : {}),
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
        ...(input.interviewPoster ? { interviewPoster: input.interviewPoster } : {}),
        worktreePath: input.worktreePath,
      });
      attempts.push(architect.attempt);
      architectCostUsd = architect.attempt.totalCostUsd;
      console.warn(
        `[pipeline] architect done attempt=${planAttempt} ok=${architect.attempt.ok} ` +
          `approved=${architect.approved} planLen=${architect.plan.length}`,
      );

      if (!architect.attempt.ok) {
        return failed(attempts, 'architect failed');
      }
      if (architect.interview) {
        return {
          status: 'awaiting_interview',
          attempts,
          interviewQuestions: architect.interview.questions,
        };
      }
      if (architect.plan.trim().length === 0) {
        return failed(attempts, 'architect returned empty plan');
      }
      if (!architect.approved) {
        if (input.abortSignal.aborted) return cancelled(attempts);
        return failed(attempts, 'architect plan not approved');
      }
      if (input.abortSignal.aborted) return cancelled(attempts);

      // No plan-reviewer configured → accept the plan as-is (M1 behavior).
      if (!input.routing.planReviewer) {
        plan = architect.plan;
        planSummary = extractSummary(plan);
        break;
      }

      console.warn(`[pipeline] plan-reviewer starting (attempt ${planAttempt})`);
      const review = await runPlanReviewer({
        plan: architect.plan,
        brief: input.task.body,
        attempt: planAttempt,
        architectSpec: input.routing.architect,
        reviewerSpec: input.routing.planReviewer,
        workerPool: input.workerPool,
        abortSignal: input.abortSignal,
        priorReasons,
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
        ...(input.task.repo
          ? { repoSlug: input.task.repo.replace(/\//g, '_') }
          : {}),
        ...(architectCostUsd !== undefined ? { architectCostUsd } : {}),
        worktreePath: input.worktreePath,
      });
      attempts.push(review.attempt);

      if (review.skipped) {
        // Spec: skipped review must not block the editor. Emit an event,
        // log, and proceed to the editor with the current plan.
        console.warn(`[pipeline] plan-reviewer skipped (${review.skipped})`);
        input.eventSink?.({
          kind: 'plan_reviewer.skipped',
          taskId: input.task.id,
          attempt: planAttempt,
          reason: review.skipped,
        });
        plan = architect.plan;
        planSummary = extractSummary(plan);
        break;
      }

      if (review.review.decision === 'approve') {
        plan = architect.plan;
        planSummary = extractSummary(plan);
        break;
      }

      // Veto path. Record reasons; if this was the last allowed cycle,
      // escalate. Otherwise loop and re-plan.
      priorReasons.push(...review.review.reasons);
      input.eventSink?.({
        kind: 'plan_reviewer.vetoed',
        taskId: input.task.id,
        attempt: planAttempt,
        reasons: review.review.reasons,
      });
      console.warn(
        `[pipeline] plan-reviewer vetoed (attempt ${planAttempt}/${PLAN_REVIEWER_MAX_VETOES}): ` +
          review.review.reasons.map((r) => `[${r.kind}] ${r.message}`).join('; '),
      );

      if (planAttempt >= PLAN_REVIEWER_MAX_VETOES) {
        const escalation = formatPlanReviewerEscalation(input.task.id, review.review.reasons);
        input.eventSink?.({
          kind: 'plan_reviewer.escalated',
          taskId: input.task.id,
          attempts: planAttempt,
          reasons: review.review.reasons,
        });
        // Post the escalation to the issue when one exists, so the human
        // pinged on Discord can see the structured disagreement.
        if (input.task.issueNumber > 0) {
          await input.issues.comment(input.task.issueNumber, escalation).catch(() => {});
        }
        return failed(attempts, `plan-reviewer escalated after ${planAttempt} vetoes`);
      }
      // else fall through, loop iterates with priorReasons fed back to the architect
    }
    if (plan.length === 0) {
      // Defensive — the loop above always sets `plan` or returns. If we get
      // here it means the loop counter expired without an explicit exit,
      // which is itself a bug worth reporting rather than silently passing.
      return failed(attempts, 'architect/plan-reviewer loop exited without a plan');
    }

    // === Editor (initial) + verify loop with doctor ===
    let diff = '';
    let lastVerify: VerifyResult | null = null;

    {
      console.warn(`[pipeline] editor starting model=${input.routing.editor.model} worktree=${input.worktreePath}`);
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
      console.warn(`[pipeline] editor done ok=${editor.attempt.ok} diffLen=${editor.diff.length} outputSnip=${JSON.stringify(editor.attempt.output.slice(0, 300))}`);
      if (!editor.attempt.ok) return failed(attempts, 'editor failed');
      diff = editor.diff;
      // Empty diff means the editor returned ok=true but made no file edits —
      // typically a silent tool-use failure in `claude -p` print mode (often
      // haiku). Bail before the reviewer burns tokens on "no diff provided".
      if (!diff.trim()) {
        return failed(attempts, 'editor produced no diff — possible silent tool-use failure');
      }
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
        worktreePath: input.worktreePath,
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
    // Track the reviewer's last verdict so we can emit `reviewer.rejected`
    // with concerns+raw before returning `blocked_by_reviewer` (issue #163).
    let lastReviewerVerdict: ReviewerVerdict | null = null;
    let roundsRun = 0;
    for (let round = 1; round <= reviewerMaxRounds; round++) {
      if (input.abortSignal.aborted) return cancelled(attempts);
      const reviewer = await runReviewer({
        editorSpec: input.routing.editor,
        reviewerSpec: input.routing.reviewer,
        haikuGateSpec: input.routing.haikuGate,
        availableProviders: poolProviders,
        workerPool: input.workerPool,
        brief: input.task.body,
        plan,
        diff,
        abortSignal: input.abortSignal,
        worktreePath: input.worktreePath,
      });
      attempts.push(reviewer.attempt);
      if (reviewer.gate === 'haiku') {
        input.eventSink?.({
          kind: 'reviewer.haiku_gate_passed',
          taskId: input.task.id,
          round,
          gateWorkerId: input.routing.haikuGate?.workerId ?? 'unknown',
        });
      }
      reviewSummary = formatReviewSummary(reviewer.verdict.verdict, reviewer.verdict.concerns);
      lastReviewerVerdict = reviewer.verdict;
      roundsRun = round;

      console.warn(
        `[pipeline] reviewer round=${round}/${reviewerMaxRounds} gate=${reviewer.gate} verdict=${reviewer.verdict.verdict}` +
          (reviewer.verdict.concerns.length > 0
            ? ` concerns: ${reviewer.verdict.concerns.map((c, i) => `(${i + 1}) ${c}`).join(' | ')}`
            : ''),
      );

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
      // Issue #163: emit the reviewer's verdict+concerns before returning so
      // operators can diagnose the rejection from the events log instead of
      // seeing only `task.capability_blocked` with exitCode:3.
      if (lastReviewerVerdict) {
        input.eventSink?.({
          kind: 'reviewer.rejected',
          taskId: input.task.id,
          verdict: lastReviewerVerdict.verdict,
          concerns: lastReviewerVerdict.concerns,
          raw: lastReviewerVerdict.raw,
          roundCount: roundsRun,
        });
      }
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

    // Audit-fix close-out: when this task was dispatched by `/audit-fix`, its
    // goal carries an `[audit-fix:<id>]` tag — mark the finding closed in
    // `.audits/index.json` now that a PR exists. Best-effort bookkeeping;
    // never let it fail an otherwise-successful pipeline run.
    maybeCloseAuditFinding(input, opened.url);

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

function maybeCloseAuditFinding(input: PipelineInput, prUrl: string): void {
  if (!input.repoRoot) return;
  const findingId = extractAuditFindingId(input.task.body);
  if (!findingId) return;
  try {
    const closed = markFindingClosed(resolveAuditIndexPath(input.repoRoot), findingId, prUrl);
    if (closed) {
      console.warn(`[pipeline] audit finding ${findingId} marked closed → ${prUrl}`);
    }
  } catch (err) {
    console.warn(
      `[pipeline] audit-fix close-out failed for ${findingId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
      // Worker adapters that don't surface USD cost (Codex today) leave
      // `totalCostUsd` undefined on the attempt; we record 0 so the JSONL
      // record stays well-formed. durationMs remains the fallback signal.
      totalCostUsd: attempt.totalCostUsd ?? 0,
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

function augmentTaskWithVetoReasons(
  task: QueuedTask,
  reasons: PlanReviewVetoReason[],
): QueuedTask {
  if (reasons.length === 0) return task;
  const header =
    '## Plan-Reviewer vetoed the prior plan — address every reason before replanning';
  const lines = reasons.map(
    (r, i) =>
      `${i + 1}. [${r.kind}] ${r.message}\n   suggested revision: ${r.suggested_revision}`,
  );
  const appended = `${task.body}\n\n${header}\n${lines.join('\n')}`;
  return { ...task, body: appended };
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
