# IFleet MCP server

Exposes four tools (`submitSprint`, `getSprint`, `cancelSprint`, `listActive`) over MCP stdio so a Claude Desktop or Claude Code session can drive the IFleet queue without touching the GitHub UI.

## Tool surface

| Tool | Input | What it does |
|---|---|---|
| `submitSprint` | `{ brief, repo?, mode?, title? }` | Opens an `auto:ship` issue in the target repo. The GitHub queue picks it up on its next poll. Returns `{ id, issueNumber, repo, url }`. |
| `getSprint` | `{ id: "owner/name#number" }` | Reads the issue and classifies it: `pending` / `in_flight` / `shipped` / `failed` / `blocked` / `closed`. |
| `cancelSprint` | `{ id, reason? }` | Adds the `blocked:missing-capability` label so the queue stops promoting the task. Existing labels are preserved. |
| `listActive` | `{ repo? }` | Returns the union of open issues with `auto:ship` (pending) and `in_flight` (running) labels. |

`repo` defaults to `MCP_DEFAULT_REPO` (env var) or `weautomatehq1/IFleet`. `mode` is recorded as an HTML comment in the issue body for the classifier to read; it is not currently passed through any other channel.

The "id" string is always `owner/name#number`. Outside of MCP, that's just the GitHub issue URL minus the prefix.

## Architecture

The MCP layer is a thin Octokit wrapper. It never touches `src/orchestrator/`, `src/queue/`, or `src/contracts/`. All four tools go through GitHub's REST API:

- `submitSprint` → `POST /repos/{owner}/{repo}/issues` with `labels: ["auto:ship"]`
- `getSprint` → `GET /repos/{owner}/{repo}/issues/{n}`
- `cancelSprint` → `POST /repos/{owner}/{repo}/issues/{n}/labels` adding `blocked:missing-capability`
- `listActive` → two parallel `GET /repos/{owner}/{repo}/issues?labels=...&state=open` calls, deduplicated

The existing GitHub queue (`src/queue/github.ts`) is what actually consumes the issue: it polls for `auto:ship`, runs the author allowlist, and dispatches the brief to a worker. So MCP-submitted sprints flow through the same pipeline as a manually-opened ticket.

## Wire it into Claude Code (3 commands)

```bash
# 1. Set a GitHub token with `repo` scope. The MCP server reads this from its
#    own env block — Claude Code's child-process spawn does NOT inherit your
#    shell env.
export GH_TOKEN=$(gh auth token)

# 2. Drop the server config into ~/.claude.json. Use absolute paths.
node -e '
const fs = require("fs"); const path = require("path");
const cfgPath = path.join(require("os").homedir(), ".claude.json");
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["ifleet"] = {
  command: "node",
  args: ["--import", "tsx", path.resolve("scripts/mcp-server.ts")],
  env: { GITHUB_TOKEN: process.env.GH_TOKEN, MCP_DEFAULT_REPO: "weautomatehq1/IFleet" }
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.error("wrote", cfgPath);
'

# 3. Restart Claude Code (`/exit` then re-launch) so the MCP host re-reads the config.
```

The same JSON block works for Claude Desktop — set it under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`.

## Manual smoke test

```bash
# Just confirm the server starts and stays alive.
GITHUB_TOKEN=$(gh auth token) pnpm mcp:start
# Expect on stderr: "[mcp-server] ready (defaultRepo=weautomatehq1/IFleet)"
# stdout will be empty until a client connects — that's correct.
```

To verify the protocol framing is intact:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
  | GITHUB_TOKEN=$(gh auth token) pnpm -s mcp:start 2>/dev/null \
  | head -c 200
# Expect: a single JSON-RPC frame starting with {"jsonrpc":"2.0","id":1,"result":...}
# Anything else on stdout — even a leading newline or [dotenv] prefix — is a bug.
```

## Why stdout discipline matters

MCP stdio expects every byte on file descriptor 1 to be a newline-delimited JSON-RPC frame. Any stray write (a `console.log`, a startup banner from `dotenv`, a debug print from an imported module) corrupts the protocol and the client disconnects mid-handshake. The first attempt to ship this server (#70 → `auto:failed`) is believed to have failed for exactly this reason.

This server routes **all** diagnostics through `process.stderr` and does not import `dotenv` at all. If you add libraries here, audit their startup logs before merging.

## PM2 entry

`ecosystem.config.cjs` includes an `ifleet-mcp` block with `autorestart: false`. The MCP server is meant to be spawned per-client (one process per Claude Code session via stdio), not run as a daemon. The PM2 block exists for ad-hoc smoke testing on the VPS; leave `autorestart` off unless you have a specific reason to keep it warm.
