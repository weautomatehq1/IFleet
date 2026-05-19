import { z } from 'zod';
import { LABEL_CAPABILITY_BLOCKED } from '../../queue/types.js';
import type { McpOctokit } from '../octokit.js';
import { parseSprintId } from './id.js';

export const cancelSprintShape = {
  id: z.string().describe('Sprint id in "owner/name#number" form.'),
  reason: z
    .string()
    .max(280)
    .optional()
    .describe('Optional cancellation reason for the audit trail.'),
};

const inputSchema = z.object(cancelSprintShape);
export type CancelSprintInput = z.infer<typeof inputSchema>;

export interface CancelSprintResult {
  id: string;
  cancelled: true;
  reason: string;
}

export interface CancelSprintDeps {
  octokit: McpOctokit;
}

export async function cancelSprint(
  deps: CancelSprintDeps,
  input: CancelSprintInput,
): Promise<CancelSprintResult> {
  const parsed = inputSchema.parse(input);
  const reason = parsed.reason ?? 'cancelled via mcp';
  const { owner, repo, issueNumber, repoSlug } = parseSprintId(parsed.id);

  await deps.octokit.addLabels({
    owner,
    repo,
    issueNumber,
    labels: [LABEL_CAPABILITY_BLOCKED],
  });

  return { id: `${repoSlug}#${issueNumber}`, cancelled: true, reason };
}
