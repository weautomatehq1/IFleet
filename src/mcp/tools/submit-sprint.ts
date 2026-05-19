import { z } from 'zod';
import { SPRINT_MODES } from '../../classifier/modes.js';
import { LABEL_AUTO_SHIP } from '../../queue/types.js';
import type { SprintMode } from '../../orchestrator/types.js';
import type { McpOctokit } from '../octokit.js';

const SPRINT_MODE_VALUES = SPRINT_MODES as readonly [SprintMode, ...SprintMode[]];

export const submitSprintShape = {
  brief: z.string().min(1).describe('Sprint brief / task description (markdown).'),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/)
    .optional()
    .describe('Target repo as "owner/name". Defaults to MCP_DEFAULT_REPO env var.'),
  mode: z
    .enum(SPRINT_MODE_VALUES)
    .optional()
    .describe('Classifier SprintMode — emitted as a `mode:<value>` GitHub label.'),
  title: z
    .string()
    .max(120)
    .optional()
    .describe('Optional issue title. Defaults to first line of brief.'),
};

const inputSchema = z.object(submitSprintShape);
export type SubmitSprintInput = z.infer<typeof inputSchema>;

export interface SubmitSprintResult {
  id: string;
  issueNumber: number;
  repo: string;
  url: string;
}

export interface SubmitSprintDeps {
  octokit: McpOctokit;
  defaultRepo: string;
}

export async function submitSprint(
  deps: SubmitSprintDeps,
  input: SubmitSprintInput,
): Promise<SubmitSprintResult> {
  const parsed = inputSchema.parse(input);
  const target = parsed.repo ?? deps.defaultRepo;
  const slash = target.indexOf('/');
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`mcp.submitSprint: invalid repo "${target}" (expected "owner/name")`);
  }
  const owner = target.slice(0, slash);
  const repo = target.slice(slash + 1);

  const title = parsed.title ?? deriveTitle(parsed.brief);
  const body = renderBody(parsed.brief);
  const labels = parsed.mode
    ? [LABEL_AUTO_SHIP, `mode:${parsed.mode}`]
    : [LABEL_AUTO_SHIP];

  const issue = await deps.octokit.createIssue({
    owner,
    repo,
    title,
    body,
    labels,
  });
  return {
    id: `${target}#${issue.number}`,
    issueNumber: issue.number,
    repo: target,
    url: issue.url,
  };
}

function deriveTitle(brief: string): string {
  const firstLine = brief.split('\n').find((l) => l.trim().length > 0) ?? 'mcp sprint';
  const trimmed = firstLine.replace(/^#+\s*/, '').trim();
  return trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed;
}

function renderBody(brief: string): string {
  return `<!-- source: mcp -->\n\n${brief}`;
}
