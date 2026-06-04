# IFleet Operational Runbook

## M4-T6 KPI remediation (status: DEFERRED-OPERATOR)

The prod `pr_decisions.fingerprint` column is missing because the
`TaskStore` constructor migration (`src/queue/store.ts:225-232`) runs
only at instantiation time, and PM2 has not restarted since #312 merged.

Operator actions:
1. SSH to VPS: `ssh root@187.124.77.142`
2. `pm2 restart ifleet`
3. Verify column exists:
   ```
   sqlite3 /opt/ifleet/state/tasks.db ".schema pr_decisions" | grep fingerprint
   ```
4. Run backfill: `pnpm tsx scripts/backfill-pr-decisions.ts --repo weautomatehq1/IFleet`
5. Re-measure KPI:
   ```sql
   SELECT COUNT(*) AS total,
          SUM(CASE WHEN fingerprint IS NOT NULL THEN 1 ELSE 0 END) AS fp_rows
   FROM pr_decisions;
   ```
6. Mark M4-T6 closed in `ROADMAP.md` and `splits/20260604-0910-m5-proposer-substrate/MASTER.md` once ratio ≥ 50%.

**Why this is gated on operator action, not code:** the migration already
runs correctly — local round-trips show 100% fingerprint coverage. The
VPS schema is stale only because PM2 never restarted after #312. No code
change is needed; a `pm2 restart` triggers the `ALTER TABLE` path in
`TaskStore` and all new rows thereafter get fingerprints populated by the
M4 wiring.
