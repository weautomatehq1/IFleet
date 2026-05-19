import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpOctokit } from './octokit.js';
import {
  cancelSprint,
  cancelSprintShape,
  type CancelSprintInput,
} from './tools/cancel-sprint.js';
import {
  getSprint,
  getSprintShape,
  type GetSprintInput,
} from './tools/get-sprint.js';
import {
  listActive,
  listActiveShape,
  type ListActiveInput,
} from './tools/list-active.js';
import {
  submitSprint,
  submitSprintShape,
  type SubmitSprintInput,
} from './tools/submit-sprint.js';

export interface CreateMcpServerOptions {
  octokit: McpOctokit;
  defaultRepo: string;
  /** Server display name. Defaults to "ifleet-mcp". */
  name?: string;
  /** Server version. Defaults to the package version at runtime. */
  version?: string;
}

const NAME = 'ifleet-mcp';
const VERSION = '0.1.0';

export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: opts.name ?? NAME, version: opts.version ?? VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'submitSprint',
    {
      description: 'Enqueue a new sprint by opening an auto:ship issue in the target repo.',
      inputSchema: submitSprintShape,
    },
    async (input: SubmitSprintInput) => {
      const result = await submitSprint(
        { octokit: opts.octokit, defaultRepo: opts.defaultRepo },
        input,
      );
      return jsonResult(result);
    },
  );

  server.registerTool(
    'getSprint',
    {
      description: 'Read the current state and labels of a sprint by id ("owner/name#number").',
      inputSchema: getSprintShape,
    },
    async (input: GetSprintInput) => {
      const result = await getSprint({ octokit: opts.octokit }, input);
      return jsonResult(result);
    },
  );

  server.registerTool(
    'cancelSprint',
    {
      description: 'Signal cancellation by labeling the issue blocked:missing-capability.',
      inputSchema: cancelSprintShape,
    },
    async (input: CancelSprintInput) => {
      const result = await cancelSprint({ octokit: opts.octokit }, input);
      return jsonResult(result);
    },
  );

  server.registerTool(
    'listActive',
    {
      description: 'List open sprints with auto:ship or in_flight labels.',
      inputSchema: listActiveShape,
    },
    async (input: ListActiveInput) => {
      const result = await listActive(
        { octokit: opts.octokit, defaultRepo: opts.defaultRepo },
        input,
      );
      return jsonResult(result);
    },
  );

  return server;
}

function jsonResult<T>(value: T): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
