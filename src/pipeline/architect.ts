import type {
  ApprovalGate,
  AttemptRecord,
  IssueCommenter,
  QueuedTask,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { ARCHITECT_SYSTEM_PROMPT } from './prompts.js';

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
}

export interface ArchitectOutput {
  attempt: AttemptRecord;
  plan: string;
  approved: boolean;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export async function runArchitect(input: RunArchitectInput): Promise<ArchitectOutput> {
  const startedAt = Date.now();
  const handle = input.workerPool.spawn(input.spec, input.task.body, {
    role: 'architect',
    systemPrompt: ARCHITECT_SYSTEM_PROMPT,
    abortSignal: input.abortSignal,
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
    return { attempt, plan: result.output, approved: false };
  }

  const plan = result.output;

  // Surface the plan to any subscriber (the daemon emits
  // `architect.plan_ready` and DiscordOut posts the approval buttons).
  if (input.onPlanReady) {
    try {
      await input.onPlanReady(plan);
    } catch (err) {
      // never let a subscriber failure derail the pipeline
      // eslint-disable-next-line no-console
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
