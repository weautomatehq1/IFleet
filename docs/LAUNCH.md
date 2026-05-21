# IFleet — Launch Day Runbook

Operator runbook for cutting IFleet over from "working in dev" to "live and
autonomous on the VPS." This is the single document the on-call human reads
before, during, and after launch.

Companion docs:
- `docs/ARCHITECTURE.md` — system shape and design constraints
- `docs/RUNNING.md` — day-to-day operations
- `docs/MODEL-ROUTING.md` — which model handles which sprint phase
- `docs/runbooks/` — task-specific runbooks (stuck worktree recovery, etc.)

---

## 1. Prereqs

Confirm every box before declaring "go for launch."

### Infrastructure
- [ ] VPS reachable: `ssh root@187.124.77.142 'uptime'` returns within 2 s.
- [ ] DNS resolves: `dig +short control.weautomatehq.cloud` returns the VPS IP.
- [ ] TLS valid: `curl -sI https://control.weautomatehq.cloud/healthz` returns
      `HTTP/2 200` with a non-expired cert.
- [ ] Disk has headroom: `df -h /` shows < 80% used.

### Secrets present (on VPS, in `/etc/environment`)
- [ ] `ANTHROPIC_API_KEY` — Claude Max account key
- [ ] `OPENAI_API_KEY` — Codex Pro account key
- [ ] `GITHUB_TOKEN` — fine-grained PAT scoped to `weautomatehq1/IFleet` and target client repos
- [ ] `DISCORD_BOT_TOKEN` — bot in the `#ifleet` channel
- [ ] `DISCORD_HMAC_SECRET` — shared between bot and `/control` endpoint
- [ ] `RESEND_API_KEY` — email digest
- [ ] `BUDGET_USD` — set to a launch-day safety cap (start with `5.00`)

Verify with `ssh root@187.124.77.142 'set | grep -E "ANTHROPIC|OPENAI|GITHUB|DISCORD|RESEND|BUDGET"' | wc -l` — expect 7.

### PM2 processes online
```bash
ssh root@187.124.77.142 'pm2 jlist | jq -r ".[] | \"\(.name) \(.pm2_env.status)\""'
```
Expect:
- `control-plane    online`
- `ifleet           online`
- `ifleet-mcp       online`
- `doctor-scan      online`

Any process in `errored` or `stopped` is a no-go.

### Discord bot
- [ ] Bot user visible in `#ifleet` channel member list
- [ ] `/healthz` ping in `#ifleet` returns within 5 s (Discord round-trip)
- [ ] Last bot message timestamp < 24 h old

---

## 2. Smoke test (no-op sprint)

Goal: fire a do-nothing sprint, confirm the full pipeline executes, and see a
draft PR open within 10 minutes.

1. From your laptop, open `#ifleet` in Discord.
2. Post:
   ```
   /sprint goal: "smoke test — no-op, post a comment in README and open PR" repo: IFleet mode: smoke
   ```
3. Within 30 s the bot should react with ✅ (HMAC validated, sprint queued).
4. Tail orchestrator logs:
   ```bash
   ssh root@187.124.77.142 'pm2 logs ifleet --lines 50 --nostream'
   ```
   Expect `sprint_started`, then `worker_spawned`, then `pipeline_phase_complete` × 3.
5. Within 10 min, GitHub should show a new draft PR in
   `weautomatehq1/IFleet`. Title prefix: `chore(smoke):`.
6. Reviewer-bot leaves a Discord summary in `#ifleet` once the PR is open.

**Pass criteria:** PR open within 10 min + no `error`-level entries in the
event log / PM2 logs during the sprint window + budget ledger increment < $0.05.

**Fail action:** if no PR appears in 15 min OR the event log / PM2 logs show
`error`-level entries → go to §3 (rollback) before debugging further.

---

## 3. Rollback

If launch goes wrong, contain first, debug second. Order matters.

```bash
# 1. Halt all new work (preserves in-flight sprints)
ssh root@187.124.77.142 'pm2 stop ifleet ifleet-mcp doctor-scan'

# 2. Leave control-plane running so Discord can still reach /healthz
#    (verifies the network path is OK while ifleet itself is paused)

# 3. If the bad change is a recent merge, revert it
cd ~/dev/ai-products/IFleet-work
git revert <bad-commit-sha> --no-edit
git push origin main

# 4. Re-deploy from main on the VPS
ssh root@187.124.77.142 'cd /opt/ifleet && git fetch && git reset --hard origin/main && pnpm install --frozen-lockfile && pnpm build'

# 5. Restart in order — control-plane first, then ifleet
ssh root@187.124.77.142 'pm2 start control-plane && sleep 5 && pm2 start ifleet ifleet-mcp doctor-scan'

# 6. Re-run §2 smoke test before declaring "recovered"
```

If `pm2 stop ifleet` doesn't actually stop the worker children (PM2 → worker
detach issue from sprint #75), escalate: `ssh root@187.124.77.142 'pkill -f
spawn-runner'` followed by `pm2 restart ifleet`.

Hard rollback (last resort): `git revert` the deploy commit on `main`, push,
and wait for the VPS cron-pull (every 5 min) to re-sync.

---

## 4. First-hour monitoring

Tail these in four panes for the first 60 min after launch.

| Pane | Command / URL | What you're watching for |
|---|---|---|
| 1 — orchestrator log | `ssh root@187.124.77.142 'pm2 logs ifleet'` | `sprint_started`, `pipeline_phase_complete`, NO `error`/`fatal` |
| 2 — control-plane log | `ssh root@187.124.77.142 'pm2 logs control-plane'` | HMAC validation passes, 200s on `/control` |
| 3 — GitHub PR feed | `gh pr list --repo weautomatehq1/IFleet --state open --limit 20` | PRs opening at the expected cadence (~3/hr in smoke mode) |

Also keep `#ifleet` Discord channel visible — the bot posts a status line per
sprint completion, and ApprovalGate verdict requests show up there.

Budget watch: every 15 min, `cat /opt/ifleet/.omc/costs.json | jq .total` —
must stay under the launch-day `BUDGET_USD` cap. Auto-pause kicks in at the
cap but verify the pause Discord webhook fires (it's the canary that the
guard is wired up).

---

## 5. Owner contact map

| Surface | Owner | Backup |
|---|---|---|
| Orchestrator + deploy | Seb | — |
| Factory specs + agent prompts | Esme | Seb |
| VPS / nginx / PM2 | Seb | — |
| GitHub repo + branch protection | Seb | Esme |
| Discord bot + control plane | Seb | Esme |
| Spec-template repo (`weautomatehq1/spec-template`) | Esme | Seb |

Escalation: anything red for > 15 min → ping Seb directly in `#ifleet`. If
Seb is offline, Esme has revert authority on the spec-template; deploy
revert stays with Seb.

---

## 6. Known issues at launch

Cross-reference these before filing new bugs.

| Issue | Status | Workaround |
|---|---|---|
| Sprint #75 worker crash loop (`code=1` on spawn) | Open — T2 debugging | Don't enable `auto-router-haiku` mode at launch; stick to default routing |
| PM2 `cron_restart` killing pipeline workers mid-run | Mitigated via worker detach (PR #95) | If a sprint dies mid-pipeline, check `pm2 describe ifleet` for `cron_restart` field — should be empty |
| Opus rate limit ceiling (~3 concurrent per account) | By design | Sprint dispatcher enforces 3-lane cap per account; don't manually fan out more |
| `BUDGET_USD` ledger drift on aborted sprints | Open | Manually subtract aborted-sprint cost from `.omc/costs.json` if it skews the cap |
| Discord MCP `DISCORD_USER_LABEL` env not picked up after PM2 restart | Mitigated — set in `/etc/environment`, not `.env` | Confirm with `pm2 env <id> | grep DISCORD_USER_LABEL` |
| Stale local branches accumulate fast | Tracked via this T5 cleanup | Run `git branch --merged main | xargs -n1 git branch -d` weekly |

---

## 7. Roadmap / sprint planning — where it lives

IFleet does **not** maintain `ROADMAP.md` or `SPRINT.md` at its repo root.
Both live in the umbrella factory repo:

- Roadmap: https://github.com/weautomatehq1/factory/blob/main/ROADMAP.md
- Active sprint: https://github.com/weautomatehq1/factory/blob/main/SPRINT.md

IFleet's local source-of-truth for next work is the GitHub issue queue
(`gh issue list --repo weautomatehq1/IFleet --state open --label "ready"`).
The continuous-execution loop in `CLAUDE.md` should read those issues, not
repo-local spec files.

If a future workflow needs repo-local stubs, add them as one-line pointers
to the factory docs above — don't duplicate roadmap content.
