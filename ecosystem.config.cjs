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

const fs = require('fs');
const path = require('path');

// Load .env from project root so secrets stay out of the committed config.
const envFile = path.join(__dirname, '.env');
const dotEnv = {};
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach((line) => {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key) dotEnv[key] = val;
      }
    });
}

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
        // SSH_AUTH_SOCK is a runtime socket path — must come from the shell,
        // not .env, because it changes every session.
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
        ...dotEnv,
      },
    },
  ],
};
