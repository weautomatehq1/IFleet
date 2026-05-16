import type {
  AttemptRecord,
  IssueCommenter,
  QueuedTask,
  SprintMode,
  WorkerPool,
  WorkerSpec,
} from './types.js';
import { buildArchitectPrompt } from './prompts.js';

export interface RunArchitectInput {
  task: QueuedTask;
  workerPool: WorkerPool;
  spec: WorkerSpec;
  issues: IssueCommenter;
  abortSignal: AbortSignal;
  approver: string;
  sprintMode?: SprintMode;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
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
    systemPrompt: buildArchitectPrompt(input.sprintMode ?? 'default'),
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
  await input.issues.comment(
    input.task.issueNumber,
    formatPlanComment(plan, input.spec),
  );

  if (input.task.autonomy === 'auto') {
    return { attempt, plan, approved: true };
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
