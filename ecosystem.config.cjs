/**
 * PM2 ecosystem config — Discord-first IFleet topology.
 *
 * Audit-verified 2026-05-25: no duplicate out_file/error_file keys; all
 * scheduled audit entries point to scripts/audit-ritual.ts (not standup.ts).
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

const logDir = path.join(process.env.HOME || require('os').homedir(), '.pm2', 'logs');

// Minimal .env parser used at PM2 boot.
// Note: this parser does NOT handle multi-line values, `export FOO=...`
// statements, surrounding quotes, escaped characters, or `${VAR}` expansion.
// If you need any of those, pre-process the .env outside PM2 or switch to a
// real dotenv library.
const envFile = path.join(__dirname, '.env');
const dotEnv = {};
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach((line) => {
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        // Strip inline comments, then strip surrounding quotes so that
        // `SECRET="abc123"` stores `abc123` (not `"abc123"`).
        let val = line.slice(eq + 1).replace(/#.*$/, '').trim();
        val = val.replace(/^(['"])(.*)\1$/, '$2');
        if (key) dotEnv[key] = val;
      }
    });
}

const baseEnv = {
  NODE_ENV: 'production',
  // Runtime socket — must come from the shell, not .env, since it changes
  // every session.
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
  // Audit + KG plumbing: passed through from the shell so PM2 picks them up
  // even when project .env is missing or stale (e.g. fresh VPS bootstrap
  // before deploy/install-vps.sh has hydrated .env). Empty string means
  // "unset" — the consuming module decides whether to warn or no-op.
  // Closes AUDIT-IFleet-ef930b21, AUDIT-IFleet-f9d5682b.
  IFLEET_KG_DATABASE_URL: process.env.IFLEET_KG_DATABASE_URL ?? '',
  IFLEET_REPO_ROOT: process.env.IFLEET_REPO_ROOT ?? '/opt/ifleet',
  CLAUDE_BIN: process.env.CLAUDE_BIN ?? '',
  ...dotEnv,
};

module.exports = {
  apps: [
    {
      name: 'control-plane',
      script: 'src/server.ts',
      interpreter: './node_modules/.bin/tsx',
      interpreter_args: '',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      min_uptime: 10_000,
      exp_backoff_restart_delay: 200,
      kill_timeout: 8_000,
      watch: false,
      env: {
        ...baseEnv,
        CONTROL_PLANE_PORT: process.env.CONTROL_PLANE_PORT ?? '3001',
        IFLEET_ROLE: 'control-plane',
      },
      out_file: `${logDir}/control-plane-out.log`,
      error_file: `${logDir}/control-plane-error.log`,
    },
    {
      name: 'ifleet',
      script: 'src/orchestrator/daemon.ts',
      interpreter: './node_modules/.bin/tsx',
      interpreter_args: '',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
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
      out_file: `${logDir}/ifleet-out.log`,
      error_file: `${logDir}/ifleet-error.log`,
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
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'mcp',
        MCP_DEFAULT_REPO: process.env.MCP_DEFAULT_REPO ?? 'weautomatehq1/IFleet',
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
      },
      out_file: `${logDir}/ifleet-mcp-out.log`,
      error_file: `${logDir}/ifleet-mcp-error.log`,
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
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      watch: false,
      env: {
        ...baseEnv,
        DOCTOR_SCAN_DISABLED: '1',
        IFLEET_ROLE: 'doctor-scan',
      },
      out_file: `${logDir}/doctor-scan-out.log`,
      error_file: `${logDir}/doctor-scan-error.log`,
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
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      cron_restart: '0 9 * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'standup',
      },
      out_file: `${logDir}/ifleet-standup-out.log`,
      error_file: `${logDir}/ifleet-standup-error.log`,
    },
    {
      // ifleet-canary — hourly verifier↔reviewer disagreement-rate canary.
      // Reads verifier_runs over the last 7d, compares to 0.25 threshold,
      // posts to #ifleet-ops only on transitions (dedup via
      // .ifleet/canary/alert-state.json). Off by default — flip on per VPS
      // with `pm2 set ifleet-canary:IFLEET_CANARY_ALERTING_ENABLED 1 &&
      //       pm2 restart ifleet-canary`.
      name: 'ifleet-canary',
      script: 'scripts/canary-alert.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      cron_restart: '0 * * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'canary',
        IFLEET_CANARY_ALERTING_ENABLED: process.env.IFLEET_CANARY_ALERTING_ENABLED ?? '0',
      },
      out_file: `${logDir}/ifleet-canary-out.log`,
      error_file: `${logDir}/ifleet-canary-error.log`,
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
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      cron_restart: '0 20 * * 0',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'retro',
      },
      out_file: `${logDir}/ifleet-retro-out.log`,
      error_file: `${logDir}/ifleet-retro-error.log`,
    },
    {
      // ifleet-audit-nightly — 4am UTC (midnight ET) daily audit run.
      // Autopilot mode: scans IFleet, factory, and audit-elevation repos.
      // One-shot cron (autorestart: false).
      name: 'ifleet-audit-nightly',
      script: 'scripts/audit-ritual.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      cron_restart: '0 4 * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'audit-nightly',
        AUDIT_MODE: 'autopilot',
        AUDIT_REPOS: 'IFleet,factory,audit-elevation',
      },
      out_file: `${logDir}/ifleet-audit-nightly-out.log`,
      error_file: `${logDir}/ifleet-audit-nightly-error.log`,
    },
    {
      // ifleet-proposer — M5 nightly goal proposer (one-shot cron).
      // Off by default until T4 (candidate-gen/dedupe/scorer/budget) and T5
      // (goal_proposals migration + approval-gate `kind: 'proposal'`) land.
      // Manual enable:
      //   pm2 set ifleet-proposer:PROPOSER_ENABLED 1 \
      //     && pm2 set ifleet-proposer:PROPOSER_REPO_IDS 'weautomatehq1/IFleet' \
      //     && pm2 restart ifleet-proposer
      name: 'ifleet-proposer',
      script: 'scripts/proposer-run.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      // 7am UTC nightly (3am ET/EDT in summer, 2am EST in winter). Well clear
      // of the 4am UTC nightly audit and 9am standup. Cron uses the PM2
      // process timezone (server typically UTC).
      cron_restart: '0 7 * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'proposer',
        PROPOSER_ENABLED: process.env.PROPOSER_ENABLED ?? '0',
        PROPOSER_REPO_IDS: process.env.PROPOSER_REPO_IDS ?? '',
        PROPOSER_REPO_ROOT: process.env.PROPOSER_REPO_ROOT ?? process.env.IFLEET_REPO_ROOT ?? '/opt/ifleet',
      },
      out_file: `${logDir}/ifleet-proposer-out.log`,
      error_file: `${logDir}/ifleet-proposer-error.log`,
    },
    {
      // ifleet-drift-scan — M6 weekly drift detector (one-shot cron).
      // Substrate from PR #353 finds cross-repo symbol drift and emits
      // candidate plans; this cron makes them visible in #ifleet. Does NOT
      // open PRs — that live-PR step is gated on the M6 ≥70% candidate-
      // merge-rate KPI.
      //
      // Off by default. Manual enable:
      //   pm2 set ifleet-drift-scan:DRIFT_SCAN_ENABLED 1 \
      //     && pm2 restart ifleet-drift-scan
      name: 'ifleet-drift-scan',
      script: 'scripts/drift-scan-run.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      // Sunday 2am UTC — clear of standup (9am), audit nightly (4am), audit
      // morning (11am), and the Sunday 8pm retro.
      cron_restart: '0 2 * * 0',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'drift-scan',
        DRIFT_SCAN_ENABLED: process.env.DRIFT_SCAN_ENABLED ?? '0',
        DRIFT_SCAN_REPOS: process.env.DRIFT_SCAN_REPOS ?? '',
      },
      out_file: `${logDir}/ifleet-drift-scan-out.log`,
      error_file: `${logDir}/ifleet-drift-scan-error.log`,
    },
    {
      // ifleet-audit-morning — 11am UTC (7am ET) daily audit morning report.
      // Morning report mode: summary and incident digest.
      // One-shot cron (autorestart: false).
      name: 'ifleet-audit-morning',
      script: 'scripts/audit-ritual.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      autorestart: false,
      max_restarts: 10,
      restart_delay: 4000,
      stop_exit_codes: [2],
      cron_restart: '0 11 * * *',
      watch: false,
      env: {
        ...baseEnv,
        IFLEET_ROLE: 'audit-morning',
        AUDIT_MODE: 'morning-report',
        AUDIT_REPOS: 'IFleet,factory,audit-elevation',
      },
      out_file: `${logDir}/ifleet-audit-morning-out.log`,
      error_file: `${logDir}/ifleet-audit-morning-error.log`,
    },
  ],
};
