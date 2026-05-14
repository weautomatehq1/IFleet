/**
 * PM2 ecosystem config for the IFleet fleet daemon.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs   # start and schedule
 *   pm2 save                          # persist across reboots
 *   pm2 startup                       # install PM2 init script (run the printed command as root)
 *   pm2 logs ifleet                   # tail logs
 *   pm2 status                        # check last run, next scheduled tick
 *   pm2 stop ifleet                   # pause without removing schedule
 *   pm2 delete ifleet                 # remove entirely
 *
 * Design notes:
 *   - autorestart: false  — the script processes one issue and exits.
 *                           PM2 must NOT restart it on exit (it would spin in a loop).
 *   - cron_restart        — wakes the fleet every 5 minutes to pick the next issue.
 *   - interpreter_args    — tsx registers the TypeScript loader via --import before
 *                           Node evaluates any file, so .ts imports resolve correctly.
 */

module.exports = {
  apps: [
    {
      name: 'ifleet',
      script: 'scripts/run-smoke.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cron_restart: '*/5 * * * *',
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
        DISCORD_IFLEET_WEBHOOK: '', // Discord webhook URL for budget-pause and rate-limit alerts
        BUDGET_USD: '', // Sprint cost cap in USD; empty = no cap
      },
    },
  ],
};
