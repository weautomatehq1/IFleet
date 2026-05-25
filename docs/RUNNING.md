# Running IFleet

IFleet is a fire-and-forget script. Each invocation picks the next `auto:ship` issue from GitHub, runs the full pipeline (Architect → Editor → Verify → Reviewer), and opens a draft PR. Then it exits. No long-running server needed.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pipeline is structured.

---

## Prerequisites

**Node** — v24+ recommended (v20+ minimum per `engines` in `package.json`).

```
node --version
```

**gh CLI** — authenticated to the `weautomatehq1` org.

```
gh auth status
```

**pnpm** — install dependencies if you haven't already.

```
pnpm install
```

**Environment variables** — copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `RESEND_API_KEY` | Yes | Email delivery for notifications. Get from resend.com/api-keys. |
| `BUDGET_USD` | No | Pause a sprint when cumulative spend reaches this USD threshold. **Only enforced when at least one enabled worker in `config/workers.json` has `authProfile: "api"`** (the literal string `"api"` — case-sensitive; matched against the `API_AUTH_PROFILE` constant in `src/orchestrator/workers.ts`). Max-plan workers report token-priced USD that does not reflect real spend, so the guard short-circuits to skip and emits a `sprint.budget_skipped` event (one per sprint) to the `events` table — query with `sqlite3 ~/.omc/ifleet/state.db "SELECT * FROM events WHERE kind='sprint.budget_skipped'"`. Omit `BUDGET_USD` to disable entirely. See issue #162. |
| `DISCORD_IFLEET_WEBHOOK` | No | Discord webhook URL for fleet broadcasts (pickup / PR opened / failure / cancel / pause / stop). **Required in practice** — without it every task is silent and you'll learn about token-burn from the bill, not from Discord. Set in `/opt/ifleet/.env` on the VPS AND `~/dev/IFleet/.env` on the Mac. Rotation: create a new webhook in Discord channel settings, update both `.env` files, restart `pm2 restart ifleet --update-env`. The URL is not high-sensitivity (write-only, single channel, easy to regenerate) but anyone with SSH access can read it from the file. |
| `GITHUB_TOKEN` | No | Falls back to `gh auth token` automatically if not set. |

---

## Account configuration

IFleet uses **exactly one Claude Max plan** via the Claude Code CLI (no account rotation, no Anthropic API consumption at runtime).

- Workers are spawned via `claude -p` (print mode). The adapter passes `--profile <authProfile>` when `authProfile` is not `"default"`. For `claude-max-1` (`authProfile: "default"`) no `--profile` flag is needed — the default CLI login is used.
- `config/workers.json` must have **exactly one worker enabled** (`claude-max-1`). The `claude-max-2` entry and any Codex workers are intentionally disabled.
- The `account-pool.ts` rotation primitive exists in `src/workers/` but is not exercised at runtime. Future backends (vLLM, Ollama, MLX, Anthropic API) live in `src/workers/adapters/` — each registers via `registry.ts` and is independent of `account-pool.ts`.
- No Anthropic API key is required for runtime (though one may be set for tooling like `ts-node`; it is never consumed by IFleet itself).

---

## One-shot run

Pick the next `auto:ship` issue and process it once:

```
pnpm start
```

Or directly:

```
node --import tsx scripts/run-smoke.ts
```

Target a specific issue number:

```
node --import tsx scripts/run-smoke.ts --issue 42
```

**Dry-run** — pick the next issue and print the routing plan without
spawning workers, creating a worktree, or labelling the issue. Safe to
run on launch eve to verify queue + classifier wiring:

```
node --import tsx scripts/run-smoke.ts --dry-run
```

The script exits 0 on success (PR opened, or dry-run plan printed) and 1 on failure. Logs are written to stdout with ISO timestamps.

---

## Scheduled run with PM2

PM2 runs the fleet on a cron schedule so it processes issues automatically every 5 minutes.

**Install PM2** (once, globally):

```
npm install -g pm2
```

**Start the fleet:**

```
pm2 start ecosystem.config.cjs
pm2 save
```

**Survive reboots** — run the printed command as root/sudo:

```
pm2 startup
# then run the command it prints
pm2 save
```

---

## Monitoring

```
pm2 status               # see last exit code, next scheduled tick
pm2 logs ifleet          # tail live logs
pm2 logs ifleet --lines 100   # last 100 lines
```

Logs are also written to `~/.pm2/logs/ifleet-out.log` and `ifleet-error.log`.

---

## Stopping

```
pm2 stop ifleet      # pause — schedule is preserved, resumes on next tick
pm2 delete ifleet    # remove from PM2 entirely
```

---

## How issues enter the fleet

1. Seb opens an issue manually (e.g. from a Discord notification, PM2 log alert, or `/audit-scan` finding).
2. The issue is labeled `auto:ship` on the `weautomatehq1/IFleet` GitHub repo.
3. On the next PM2 tick (within 5 minutes), the fleet picks it up.
4. The pipeline runs: Architect plans → Editor codes → Verify checks → Reviewer approves → draft PR opens.
5. Seb reviews and merges the draft PR in the morning.

Issues that need human input are labeled `autonomy:review` and the pipeline pauses waiting for a `@monstersebas1` approval comment on the issue.

---

## MCP server (optional)

The `ifleet-mcp` stdio server lets a Claude Code or Claude Desktop session enqueue and inspect sprints over the Model Context Protocol. It is a thin Octokit wrapper over the same `auto:ship` issue intake the queue already polls — submitting via MCP and submitting via the GitHub UI flow through the identical pipeline.

```
pnpm mcp:start
```

The server reads `GITHUB_TOKEN` from its own env block — Claude Code's child-process spawn does NOT inherit your shell env, so set the token in the MCP server's `env:` section in `~/.claude.json`. Full registration snippet and protocol notes live in [MCP.md](MCP.md).
