import type {
  ApprovalGate,
  AttemptRecord,
  IssueCommenter,
  QueuedTask,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { ARCHITECT_SYSTEM_PROMPT } from './prompts.js';
import {
  appendLearnings,
  formatPriorLearningsSection,
  parseLearningBlocks,
  readRecentLearnings,
} from './learnings.js';
import {
  INTERVIEW_SYSTEM_PROMPT,
  isVagueBrief,
  parseInterviewQuestions,
  type InterviewPoster,
  type InterviewPostResult,
} from './interview.js';

export interface RunArchitectInput {
  task: QueuedTask;
  workerPool: WorkerPool;
  spec: WorkerSpec;
  issues: IssueCommenter;
  abortSignal: AbortSignal;
  approver: string;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
  /**
   * Source-aware approval gate. When provided, takes precedence over the
   * `issues.waitForApproval` GitHub-only path. The daemon constructs this
   * to bridge `ControlPlane.onApprove` (Discord button) → architect resume.
   */
  approvalGate?: ApprovalGate;
  /** Called once with the architect's plan text before the approval gate. */
  onPlanReady?: (plan: string) => void | Promise<void>;
  /**
   * Absolute path to the host repo root. When set, the architect reads
   * `<repoRoot>/.omc/learnings.md` (last ~50 entries) into a `## Prior
   * learnings` section appended to its system prompt, and any `<learning>`
   * blocks the architect emits are appended back to the same file.
   */
  repoRoot?: string;
  /**
   * Absolute path to the per-task git worktree. Architect must run inside
   * this sandbox so any accidental file write or git op lands in the
   * throwaway worktree, never the host repo. Required in production; tests
   * may omit (defaulting to `resolve('.')` in the spawn helper).
   */
  worktreePath?: string;
  /**
   * Deep-interview poster. When provided and the brief looks vague, the
   * architect runs a question-only spawn, posts the questions via this
   * poster, and short-circuits with `approved: false` and an `interview`
   * field set so the runner can halt the sprint.
   */
  interviewPoster?: InterviewPoster;
  /** Override for the learnings timestamp (tests only). */
  now?: () => Date;
}

export interface ArchitectOutput {
  attempt: AttemptRecord;
  plan: string;
  approved: boolean;
  /**
   * Set when the architect ran the deep-interview path instead of producing
   * a plan. Runner detects this and returns `awaiting_interview`.
   */
  interview?: {
    questions: string[];
    post?: InterviewPostResult;
  };
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export async function runArchitect(input: RunArchitectInput): Promise<ArchitectOutput> {
  // === Deep-interview branch ===
  // When a poster is wired AND the brief is too vague to plan, ask up to
  // 3 clarifying questions and halt the sprint. Fall through to normal
  // planning if the architect declines to ask anything (no questions
  // parsed) so the pipeline cannot deadlock on a parser miss.
  if (input.interviewPoster && isVagueBrief(input.task.body)) {
    const interview = await runInterview(input, input.interviewPoster);
    if (interview) return interview;
  }

  const learningLines = input.repoRoot
    ? await readRecentLearnings(input.repoRoot).catch(() => [])
    : [];
  const learningsSection = formatPriorLearningsSection(learningLines);
  const systemPrompt =
    learningsSection.length > 0
      ? `${ARCHITECT_SYSTEM_PROMPT}\n\n${learningsSection}`
      : ARCHITECT_SYSTEM_PROMPT;

  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.spec, input.task.body, {
    role: 'architect',
    systemPrompt,
    abortSignal: input.abortSignal,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  });

  const result = await handle.result();
  const endedAt = Date.now();

  const attempt: AttemptRecord = {
    role: 'architect',
    workerId: input.spec.workerId,
    startedAt,
    endedAt,
    ok: result.ok,
    output: result.output,
    rateLimitHits: result.rateLimitHits,
    ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
    ...(result.totalTokens !== undefined && { totalTokens: result.totalTokens }),
  };

  if (!result.ok) {
    return { attempt, plan: result.output, approved: false };
  }

  const plan = result.output;

  // Persist any `<learning>` blocks the architect surfaced before any
  // approval gating — appending later risks losing the lesson if the
  // operator rejects the plan.
  if (input.repoRoot) {
    const fresh = parseLearningBlocks(plan);
    if (fresh.length > 0) {
      const stamp = input.now ? input.now() : new Date();
      await appendLearnings(input.repoRoot, input.task.id, fresh, stamp).catch((err) => {
        console.warn('[architect] failed to append learnings:', err);
      });
    }
  }

  // Surface the plan to any subscriber (the daemon emits
  // `architect.plan_ready` and DiscordOut posts the approval buttons).
  if (input.onPlanReady) {
    try {
      await input.onPlanReady(plan);
    } catch (err) {
      // never let a subscriber failure derail the pipeline
      console.warn('[architect] onPlanReady threw:', err);
    }
  }

  // GitHub issue commenters are useless for issueNumber=0 (Discord source).
  // Skip the GitHub comment when there is no real issue to post against.
  if (input.task.issueNumber > 0) {
    await input.issues.comment(
      input.task.issueNumber,
      formatPlanComment(plan, input.spec),
    );
  }

  if (input.task.autonomy === 'auto') {
    return { attempt, plan, approved: true };
  }

  if (input.approvalGate) {
    const approved = await input.approvalGate.awaitApproval({
      taskId: input.task.id,
      timeoutMs: input.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      abortSignal: input.abortSignal,
    });
    return { attempt, plan, approved };
  }

  const approved = await input.issues.waitForApproval(input.task.issueNumber, {
    approver: input.approver,
    pollIntervalMs: input.approvalPollMs ?? DEFAULT_POLL_MS,
    timeoutMs: input.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    abortSignal: input.abortSignal,
  });

  return { attempt, plan, approved };
}

async function runInterview(
  input: RunArchitectInput,
  poster: InterviewPoster,
): Promise<ArchitectOutput | null> {
  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.spec, input.task.body, {
    role: 'architect',
    systemPrompt: INTERVIEW_SYSTEM_PROMPT,
    abortSignal: input.abortSignal,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  });
  const result = await handle.result();
  const endedAt = Date.now();

  const attempt: AttemptRecord = {
    role: 'architect',
    workerId: input.spec.workerId,
    startedAt,
    endedAt,
    ok: result.ok,
    output: result.output,
    rateLimitHits: result.rateLimitHits,
    ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
  };

  if (!result.ok) {
    // Worker failed entirely — bubble as a normal architect failure so the
    // runner records the attempt and surfaces the error.
    return { attempt, plan: result.output, approved: false };
  }

  const questions = parseInterviewQuestions(result.output);
  if (questions.length === 0) {
    // Architect didn't ask anything — fall back to normal planning rather
    // than halt forever. Caller continues to the planning spawn.
    return null;
  }

  let post: InterviewPostResult | undefined;
  try {
    post = await poster.post({
      taskId: input.task.id,
      issueNumber: input.task.issueNumber,
      repo: input.task.repo,
      questions,
    });
  } catch (err) {
    // Posting failure is non-fatal: the questions still exist on the
    // architect attempt output and the sprint halts so an operator can
    // intervene.
    console.warn('[architect] interview post failed:', err);
  }

  return {
    attempt,
    plan: '',
    approved: false,
    interview: { questions, ...(post ? { post } : {}) },
  };
}

function formatPlanComment(plan: string, spec: WorkerSpec): string {
  return [
    `## Architect plan`,
    ``,
    `_Worker: \`${spec.workerId}\` (${spec.provider}/${spec.model})_`,
    ``,
    plan,
    ``,
    `---`,
    `React with ✅ to approve and proceed to the editor.`,
  ].join('\n');
}
