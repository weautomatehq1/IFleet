/**
 * PM2 ecosystem config — Discord-first IFleet topology.
 *
 * Two long-running processes:
 *
 *   control-plane  — HTTP listener for the Discord bot's HMAC-signed
 *                    /control endpoint. Boots fast, exposes /healthz, owns
 *                    the TaskStore writes for sprint_goal ingress.
 *
 *   ifleet         — The daemon: Discord client (input), Orchestrator
 *                    (sprint dispatch), DiscordOut (output), ApprovalGate
 *                    (HITL verdict bridge). One discord.js WS connection.
 *                    Reads the same TaskStore the control-plane writes.
 *
 * The daemon ALSO runs an in-process ControlPlane on its own port (default
 * 3002) so the architect's ApprovalGate can resolve verdicts in the same
 * process the architect runs in. The standalone `control-plane` app on
 * port 3001 remains the public entry point for the Discord bot.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 *   pm2 logs control-plane
 *   pm2 logs ifleet
 *
 * Secrets live in /etc/environment on the VPS (or .env in dev). PM2 reads
 * .env from the project root and merges it into each app's env block.
 */

const fs = require('fs');
const path = require('path');

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

const baseEnv = {
  NODE_ENV: 'production',
  // Runtime socket — must come from the shell, not .env, since it changes
  // every session.
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
  ...dotEnv,
};

module.exports = {
  apps: [
    {
      name: 'control-plane',
      script: 'src/server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10_000,
      exp_backoff_restart_delay: 200,
      kill_timeout: 8_000,
      watch: false,
      env: {
        ...baseEnv,
        CONTROL_PLANE_PORT: process.env.CONTROL_PLANE_PORT ?? '3001',
        IFLEET_ROLE: 'control-plane',
      },
      out_file: '/var/log/pm2/control-plane-out.log',
      error_file: '/var/log/pm2/control-plane-error.log',
    },
    {
      name: 'ifleet',
      script: 'src/orchestrator/daemon.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10_000,
      exp_backoff_restart_delay: 200,
      // A sprint may need time to abort cleanly (kill the worker process,
      // tear down the worktree, finish any open Discord posts).
      kill_timeout: 60_000,
      watch: false,
      env: {
        ...baseEnv,
        CONTROL_PLANE_PORT: process.env.IFLEET_DAEMON_PORT ?? '3002',
        IFLEET_ROLE: 'daemon',
      },
      out_file: '/var/log/pm2/ifleet-out.log',
      error_file: '/var/log/pm2/ifleet-error.log',
    },
    {
      // ifleet-mcp — stdio MCP server. Disabled by default because MCP
      // clients (Claude Desktop / Claude Code) spawn their own per-session
      // child process; the PM2 entry exists for ad-hoc smoke testing only.
      // Flip autorestart on intentionally when you have a long-running
      // client (e.g. a remote VS Code session) that holds the stdio open.
      name: 'ifleet-mcp',
      script: 'scripts/mcp-server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'mcp',
        MCP_DEFAULT_REPO: process.env.MCP_DEFAULT_REPO ?? 'weautomatehq1/IFleet',
      },
      out_file: '/var/log/pm2/ifleet-mcp-out.log',
      error_file: '/var/log/pm2/ifleet-mcp-error.log',
    },
    {
      // Doctor self-heal cadence (periodic Haiku scan + morning learnings
      // rollup). Disabled by default — T5 flips both env+autorestart on after
      // review. Manual enable:
      //   pm2 set doctor-scan:DOCTOR_SCAN_DISABLED 0
      //   pm2 restart doctor-scan
      name: 'doctor-scan',
      script: 'scripts/doctor-scan.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      watch: false,
      env: {
        ...baseEnv,
        DOCTOR_SCAN_DISABLED: '1',
        IFLEET_ROLE: 'doctor-scan',
      },
      out_file: '/var/log/pm2/doctor-scan-out.log',
      error_file: '/var/log/pm2/doctor-scan-error.log',
    },
    {
      // ifleet-standup — 9am daily standup post to #ifleet.
      // Runs as a one-shot cron (autorestart: false). PM2 cron_restart fires
      // the process at the scheduled time; it exits after posting.
      name: 'ifleet-standup',
      script: 'src/agents/rituals/standup.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      cron_restart: '0 9 * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'standup',
      },
      out_file: '/var/log/pm2/ifleet-standup-out.log',
      error_file: '/var/log/pm2/ifleet-standup-error.log',
    },
    {
      // ifleet-retro — Sunday 8pm weekly retro post to #ifleet-ops.
      // Stub only until M5+ data is available (see src/agents/rituals/retro.ts).
      // autorestart is false so it doesn't spam. Enable when M5 ships.
      name: 'ifleet-retro',
      script: 'src/agents/rituals/retro.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      cron_restart: '0 20 * * 0',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'retro',
      },
      out_file: '/var/log/pm2/ifleet-retro-out.log',
      error_file: '/var/log/pm2/ifleet-retro-error.log',
    },
  ],
};
