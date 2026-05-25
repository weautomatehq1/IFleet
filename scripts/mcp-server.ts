// IFleet MCP server entry — stdio transport.
//
// CRITICAL — every byte written to stdout must be a JSON-RPC frame. Any stray
// stdout write (console.log, dotenv banner, library startup print, etc.) will
// corrupt the protocol and Claude will disconnect mid-handshake. All logs go
// to stderr. See docs/MCP.md for the full reasoning.

import { Octokit } from '@octokit/rest';
import { isMainModule } from './lib/is-main-module.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_REPO_ID } from '../src/config/repos.js';
import { makeOctokitAdapter, type RestClient } from '../src/mcp/octokit.js';
import { createMcpServer } from '../src/mcp/server.js';

async function main(): Promise<void> {
  const token = process.env['GITHUB_TOKEN'];
  if (!token || token.trim() === '') {
    process.stderr.write(
      '[mcp-server] fatal: GITHUB_TOKEN env var is required.\n' +
        '  When invoked via Claude Code, set it in the MCP server\'s "env" block in ~/.claude.json.\n',
    );
    process.exit(1);
  }

  const defaultRepo = process.env['MCP_DEFAULT_REPO'] ?? DEFAULT_REPO_ID;
  const rest = new Octokit({ auth: token });
  const octokit = makeOctokitAdapter(rest as unknown as RestClient);
  const server = createMcpServer({ octokit, defaultRepo });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[mcp-server] ready (defaultRepo=${defaultRepo})\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[mcp-server] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
