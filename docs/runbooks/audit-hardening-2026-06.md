# Runbook — Audit hardening sweep (2026-06-17)

This sweep fixed the open audit findings from the 2026-06-13 scan (PRs #374–#386).
Two of the fixes **change deploy requirements** — read the "Operator action required"
items below before the next `pm2 restart` / `nginx -s reload`, or the deploy will
break (author gate) or stay exposed (Langfuse).

## ⚠ Operator action required

### 1. Author allowlist is now fail-CLOSED (PR #376)
`isAuthorAllowed` (`src/queue/github.ts`) used to **allow any author** when a repo's
`allowedAuthors` was empty/undefined. On a public repo that let anyone trigger an
`auto:ship` worker. It now **denies** on an empty allowlist.

**Before deploying, do ONE of:**
- Configure `allowedAuthors` per repo (the intended fix — list the trusted GitHub logins), OR
- Set **`IFLEET_ALLOW_ALL_AUTHORS=1`** (or `=true`) in the daemon env to deliberately
  restore allow-all (only safe on a private/trusted repo).

If you do neither, **all GitHub-sourced tasks will be denied** until an allowlist exists.

### 2. Langfuse vhost now requires basic-auth (PR #374)
`nginx/langfuse.conf` `location /` (the UI/API) is now gated with `auth_basic`. Trace
**ingestion** (`/api/public/`) and **health** (`/api/public/health`) stay open so the
SDK keeps working.

**Before `nginx -s reload`, provision the htpasswd file on the host:**
```sh
htpasswd -c /etc/nginx/.htpasswd-langfuse admin   # then enter a password
# (omit -c when adding additional users)
```
Without it, `nginx -t` fails / the UI returns 401. Recommended: also set
`AUTH_DISABLE_SIGNUP=true` in the Langfuse container env so open self-signup is off.

## M6 closure flags (default OFF — no action needed unless flipping live)

The M6 closure substrate is wired but gated behind env flags that **default OFF**, so
production behavior is unchanged until you deliberately flip them on prod signal:

| Flag | Default | Effect when set to `1` |
|---|---|---|
| `DRIFT_REAL_PR` | OFF (report-only) | drift scan opens real candidate PRs instead of only reporting |
| `BANDIT_LIVE` | OFF (shadow-only) | Thompson-sampled arm becomes the actual routing decision (PR #385 wired the call site) |

Flip only after the gates in `ROADMAP.md` are met (drift PRs >70% merge rate; cost-per-task -25%).

## Other fixes in this sweep (no operator action)

- **codex worker** — child env scoped to an allowlist (no secret leak); `finalize()` now
  classifies exit so rate-limited runs re-queue instead of silently "succeeding" (#375).
- **Discord broadcast** — webhook URL/token no longer persisted at rest in SQLite;
  delivery is now exactly-once (#377).
- **BUDGET_USD cap** — `totalCostUsd` now propagates through the pipeline bridge, so the
  cap actually fires (#378).
- **force-PR** — routed through the `PrOpener` bridge (no inline octokit/git in the
  orchestrator); base branch configurable; ref inputs validated (#381).
- **verify spawn-util** — child env scoped (no parent-secret inheritance) (#379).
- **queue store** — `recoverStale` boundary fixed (no tasks stuck `in_flight`); `task.mode`
  now persists across the store round-trip (#380).
- **sprint completion** — gated per-sprint instead of on the global running set (#384).
- **operator cancel/stop** — recorded as `blocked` + `cancelled:true`, not `failed`, so
  metrics aren't corrupted (#386).
- **validate-claims** — `git diff` runs argv-style (no shell injection via `--base`) (#382).
- **tooling** — husky pre-push uses `pnpm`; eval intermediates gitignored; `eval:bootstrap`
  runs the full dump→link→filter→summarize→freeze chain (#383).

See `~/.claude/audits/IFleet/closed.json` for the full per-finding closure records.
