import type {
  GitOps,
  OpenPrInput,
  PrOpener,
  QueuedTask,
  WorkerSpec,
} from './types.js';

export interface OpenPipelinePrInput {
  task: QueuedTask;
  worktreePath: string;
  baseBranch: string;
  pr: PrOpener;
  git: GitOps;
  codeowners: string[];
  planSummary: string;
  reviewSummary: string;
  editorSpec: WorkerSpec;
  reviewerSpec: WorkerSpec;
}

export async function openPipelinePr(
  input: OpenPipelinePrInput,
): Promise<{ url: string; number: number }> {
  const headBranch = await input.git.currentBranch(input.worktreePath);

  const body = formatPrBody({
    task: input.task,
    planSummary: input.planSummary,
    reviewSummary: input.reviewSummary,
    editorSpec: input.editorSpec,
    reviewerSpec: input.reviewerSpec,
  });

  const openInput: OpenPrInput = {
    repo: input.task.repo,
    headBranch,
    baseBranch: input.baseBranch,
    title: input.task.title,
    body,
    issueNumber: input.task.issueNumber,
    reviewers: input.codeowners,
  };

  return input.pr.open(openInput);
}

interface FormatInput {
  task: QueuedTask;
  planSummary: string;
  reviewSummary: string;
  editorSpec: WorkerSpec;
  reviewerSpec: WorkerSpec;
}

function formatPrBody(input: FormatInput): string {
  return [
    `## Technical`,
    `- Task: \`${input.task.id}\` — ${input.task.title}`,
    `- Editor: \`${input.editorSpec.workerId}\` (${input.editorSpec.provider}/${input.editorSpec.model})`,
    `- Reviewer: \`${input.reviewerSpec.workerId}\` (${input.reviewerSpec.provider}/${input.reviewerSpec.model})`,
    ``,
    `## Plan summary`,
    input.planSummary,
    ``,
    `## Review summary`,
    input.reviewSummary,
    ``,
    `Closes #${input.task.issueNumber}`,
  ].join('\n');
}
