# Runbook: M5 Live Deploy

Deploy the M5 goal-proposer pipeline to the Hostinger VPS.
Run this **after** the `feat(deploy): M5 live-deploy script + runbook` PR merges
and the `#ifleet-proposals` Discord channel exists.

---

## Pre-flight checklist

- [ ] PR merged to `main` and VPS has reachable `git pull`
- [ ] `#ifleet-proposals` channel created in the Discord server
- [ ] Channel id captured (right-click channel → Copy Channel ID; must be a numeric snowflake)
- [ ] Approver Discord user id(s) known (right-click user → Copy User ID)
- [ ] SSH access to VPS works: `ssh root@<VPS_HOST> echo ok`
- [ ] `IFLEET_KG_DATABASE_URL` is available (Supabase project `ifleet-kg`, connection string from project Settings → Database → Connection string → URI mode)
- [ ] **arca namespace is off-limits** — see safety note below

---

## Execute

```bash
bash scripts/deploy-m5-live.sh \
  --vps-host root@<VPS_HOST> \
  --kg-db-url "<IFLEET_KG_DATABASE_URL>" \
  --proposals-channel-id <CHANNEL_SNOWFLAKE_ID> \
  --approver-ids "<DISCORD_USER_ID_1>,<DISCORD_USER_ID_2>"
```

Replace every `<…>` placeholder before running. The script is idempotent — safe to re-run if a step fails mid-way.

### Dry-run first (recommended)

```bash
bash scripts/deploy-m5-live.sh \
  --vps-host root@<VPS_HOST> \
  --kg-db-url "<IFLEET_KG_DATABASE_URL>" \
  --proposals-channel-id <CHANNEL_SNOWFLAKE_ID> \
  --approver-ids "<DISCORD_USER_ID_1>,<DISCORD_USER_ID_2>" \
  --dry-run
```

Prints every SSH command that would run; exits 0 without touching the VPS.

---

## What the script does (seven steps)

| Step | Action |
|------|--------|
| 1 | `git pull --ff-only origin main` on `/opt/ifleet` |
| 2 | `pnpm install --frozen-lockfile` (picks up any new deps) |
| 3 | `pnpm graph:migrate` — applies `0004-goal-proposals.sql` to the KG DB |
| 4 | Idempotently upserts `IFLEET_PROPOSALS_CHANNEL_ID`, `IFLEET_PROPOSALS_APPROVER_IDS`, `PROPOSER_ENABLED=1` into `/etc/environment` |
| 5 | `pm2 restart all --update-env` — picks up the new env vars |
| 6 | `pm2 describe ifleet-proposer \| grep cron` — confirms the cron entry is registered |
| 7 | `pm2 logs ifleet-proposer --lines 50 --nostream` — sanity-check the last 50 log lines |

Final output is either `✅ M5 live on VPS` or `❌ deploy failed at step N: <reason>`.

---

## Verification after deploy

**Confirm cron is scheduled:**
```bash
ssh root@<VPS_HOST> pm2 describe ifleet-proposer
```
Look for `cron_restart: 0 7 * * *` (fires at 07:00 UTC / 3am ET nightly).

**Confirm env vars are set:**
```bash
ssh root@<VPS_HOST> grep -E 'PROPOSER|PROPOSALS' /etc/environment
```

**Watch the next scheduled run (next day after 07:00 UTC):**
```bash
ssh root@<VPS_HOST> pm2 logs ifleet-proposer --lines 100 --nostream
```

**Confirm KG rows accumulate:**
```sql
-- run in Supabase project ifleet-kg
SELECT status, COUNT(*) FROM goal_proposals GROUP BY status;
```
After the first run you should see rows with `status = 'pending'` waiting for Discord approval.

**Confirm Discord approval flow:**
Open `#ifleet-proposals` — the bot should post a proposal card with an Approve button.
Clicking Approve calls `/ship` on the issue and updates the row `status` to `'approved'`.

---

## Rollback

The proposer is additive: `goal_proposals` rows are append-only and no existing behaviour is removed.

To disable without reverting the deploy:

```bash
ssh root@<VPS_HOST> bash -c "
  sed -i 's|^PROPOSER_ENABLED=.*|PROPOSER_ENABLED=0|' /etc/environment
  pm2 restart all --update-env
"
```

This stops the proposer cron from running. Migration 0004 stays in place (harmless). Re-enable by setting `PROPOSER_ENABLED=1` and restarting PM2 again.

---

## ⚠️ arca off-limits

The VPS also hosts **arca** — a friend's project Sebastian is co-hosting.

**Never touch:**
- PM2 entries named `arca`
- Port 3000
- `/var/www/arca`
- `arca.conf` nginx vhost

If any port or path conflict appears, route around it. Never displace arca.
