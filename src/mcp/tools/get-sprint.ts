import { z } from 'zod';
import type { McpOctokit } from '../octokit.js';
import { parseSprintId } from './id.js';

export const getSprintShape = {
  id: z
    .string()
    .describe('Sprint id in "owner/name#number" form (returned by submitSprint).'),
};

const inputSchema = z.object(getSprintShape);
export type GetSprintInput = z.infer<typeof inputSchema>;

export interface GetSprintResult {
  id: string;
  status: 'pending' | 'in_flight' | 'shipped' | 'failed' | 'blocked' | 'closed' | 'unknown';
  labels: string[];
  repo: string;
  issueNumber: number;
  title: string;
  brief: string;
  url: string;
}

export interface GetSprintDeps {
  octokit: McpOctokit;
}

export async function getSprint(
  deps: GetSprintDeps,
  input: GetSprintInput,
): Promise<GetSprintResult> {
  const parsed = inputSchema.parse(input);
  const { owner, repo, issueNumber, repoSlug } = parseSprintId(parsed.id);
  const issue = await deps.octokit.getIssue({ owner, repo, issueNumber });
  return {
    id: parsed.id,
    status: classify(issue.state, issue.labels),
    labels: issue.labels,
    repo: repoSlug,
    issueNumber,
    title: issue.title,
    brief: stripHeaderComments(issue.body),
    url: issue.url,
  };
}

function classify(
  state: 'open' | 'closed',
  labels: string[],
): GetSprintResult['status'] {
  if (state === 'closed') {
    if (labels.includes('auto:shipped')) return 'shipped';
    return 'closed';
  }
  if (labels.includes('blocked:missing-capability')) return 'blocked';
  if (labels.includes('auto:failed')) return 'failed';
  if (labels.includes('in_flight')) return 'in_flight';
  if (labels.includes('auto:ship')) return 'pending';
  return 'unknown';
}

function stripHeaderComments(body: string): string {
  return body.replace(/^<!--[^>]*-->\n?/gm, '').trimStart();
}
