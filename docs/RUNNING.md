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
| `BUDGET_USD` | No | Pause a sprint when cumulative spend reaches this USD threshold. Omit to disable. |
| `DISCORD_IFLEET_WEBHOOK` | No | Discord webhook URL for budget-pause alerts. |
| `GITHUB_TOKEN` | No | Falls back to `gh auth token` automatically if not set. |

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

The script exits 0 on success (PR opened) and 1 on failure. Logs are written to stdout with ISO timestamps.

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

1. A Sentry error fires, or Seb opens an issue manually.
2. The issue is labeled `auto:ship` on the `weautomatehq1/IFleet` GitHub repo.
3. On the next PM2 tick (within 5 minutes), the fleet picks it up.
4. The pipeline runs: Architect plans → Editor codes → Verify checks → Reviewer approves → draft PR opens.
5. Seb reviews and merges the draft PR in the morning.

Issues that need human input are labeled `autonomy:review` and the pipeline pauses waiting for a `@monstersebas1` approval comment on the issue.
