import { z } from 'zod';
import { LABEL_AUTO_SHIP, LABEL_IN_FLIGHT } from '../../queue/types.js';
import type { McpOctokit } from '../octokit.js';
import { buildSprintId } from './id.js';

export const listActiveShape = {
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/)
    .optional()
    .describe('Target repo as "owner/name". Defaults to MCP_DEFAULT_REPO env var.'),
};

const inputSchema = z.object(listActiveShape);
export type ListActiveInput = z.infer<typeof inputSchema>;

export interface ActiveSprint {
  id: string;
  status: 'pending' | 'in_flight';
  issueNumber: number;
  title: string;
  labels: string[];
  url: string;
}

export interface ListActiveResult {
  repo: string;
  count: number;
  sprints: ActiveSprint[];
}

export interface ListActiveDeps {
  octokit: McpOctokit;
  defaultRepo: string;
}

export async function listActive(
  deps: ListActiveDeps,
  input: ListActiveInput,
): Promise<ListActiveResult> {
  const parsed = inputSchema.parse(input);
  const target = parsed.repo ?? deps.defaultRepo;
  const slash = target.indexOf('/');
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`mcp.listActive: invalid repo "${target}" (expected "owner/name")`);
  }
  const owner = target.slice(0, slash);
  const repo = target.slice(slash + 1);

  // Two label queries — GitHub's `labels` filter is AND across all values, so
  // a single multi-label call would return zero. The queue marks running work
  // with `in_flight` and pending work with `auto:ship`; union both.
  const [pending, inFlight] = await Promise.all([
    deps.octokit.listIssuesByLabels({ owner, repo, labels: [LABEL_AUTO_SHIP], state: 'open' }),
    deps.octokit.listIssuesByLabels({ owner, repo, labels: [LABEL_IN_FLIGHT], state: 'open' }),
  ]);

  const seen = new Set<number>();
  const sprints: ActiveSprint[] = [];
  for (const issue of [...inFlight, ...pending]) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    sprints.push({
      id: buildSprintId(target, issue.number),
      status: issue.labels.includes(LABEL_IN_FLIGHT) ? 'in_flight' : 'pending',
      issueNumber: issue.number,
      title: issue.title,
      labels: issue.labels,
      url: issue.url,
    });
  }
  return { repo: target, count: sprints.length, sprints };
}
