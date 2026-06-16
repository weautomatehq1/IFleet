// PM2 one-shot cron entry for the M6 drift detector (see ecosystem.config.cjs,
// app `ifleet-drift-scan`). Fires weekly per cron_restart, runs runDriftScan
// over the configured repo set, posts a digest to #ifleet, exits.
//
// Off by default — gated on `DRIFT_SCAN_ENABLED=1`. The M6 substrate (PR #353)
// emits candidate plans; this cron makes them visible. Opening real drift PRs
// is a separate future PR gated on the ≥70% candidate-merge-rate KPI.
//
// Manual trigger (development):
//   DRIFT_SCAN_ENABLED=1 IFLEET_KG_DATABASE_URL=postgres://... \
//     DRIFT_SCAN_REPOS=weautomatehq1/IFleet,weautomatehq1/factory \
//     DISCORD_BOT_TOKEN=... node --import tsx scripts/drift-scan-run.ts

import { Client, GatewayIntentBits, type TextChannel } from 'discord.js';

import { runDriftScan as defaultRunDriftScan } from '../src/agents/drift-detector/scan.js';
import type {
  DriftCandidate,
  DriftScanResult,
} from '../src/agents/drift-detector/types.js';

const ENABLED_ENV = 'DRIFT_SCAN_ENABLED';
const KG_URL_ENV = 'IFLEET_KG_DATABASE_URL';
const DISCORD_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
const REPOS_ENV = 'DRIFT_SCAN_REPOS';

// Same constant as standup.ts — #ifleet.
const IFLEET_CHANNEL_ID = '1504120127791042631';

// Discord 2000-char hard limit; cap bullets to keep us well under it.
const MAX_BULLETS = 25;
const MESSAGE_CHAR_BUDGET = 1990;

const DEFAULT_REPOS = ['weautomatehq1/IFleet', 'weautomatehq1/factory'];

export interface DriftScanDeps {
  runDriftScan: (opts: { repos: string[] }) => Promise<DriftScanResult>;
  postToDiscord: (message: string) => Promise<void>;
}

function envFlag(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

function getRepos(): string[] {
  const raw = process.env[REPOS_ENV];
  if (!raw) return DEFAULT_REPOS;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_REPOS;
}

/**
 * Format a `DriftScanResult` into a Discord-ready message.
 *
 * Empty result still produces a message — operator confirmation that the
 * cron fired. Caps at MAX_BULLETS with a `… and <N> more` overflow line so
 * we never collide with Discord's 2000-char ceiling on a noisy week.
 */
export function formatMessage(result: DriftScanResult): string {
  const date = result.scannedAt.slice(0, 10);
  const header = `**Drift scan — ${date}**`;

  if (result.candidates.length === 0) {
    const repoCount = result.reposScanned.length;
    const n = repoCount > 0 ? String(repoCount) : 'all known';
    return `${header}\nDrift scan — ${date}: clean across ${n} repos.`;
  }

  const shown = result.candidates.slice(0, MAX_BULLETS);
  const overflow = result.candidates.length - shown.length;
  const lines: string[] = shown.map(formatCandidate);
  if (overflow > 0) lines.push(`… and ${overflow} more`);

  return [header, ...lines].join('\n');
}

function formatCandidate(c: DriftCandidate): string {
  // Outliers are the repos a drift PR would target; fall back to the
  // majority signature's repos if the substrate left outlierRepos empty
  // (defensive — `compareDrift` always populates outliers today).
  const repos =
    c.outlierRepos.length > 0
      ? c.outlierRepos.join(',')
      : c.groups[0]?.repos.join(',') ?? '?';
  // Severity = number of repos diverging from the majority signature.
  // Bounded below by 1 so an "everyone disagrees" cluster still reads as ≥1.
  const severity = Math.max(c.outlierRepos.length, 1);
  return `- ${repos}: ${c.driftKind} on ${c.name} (severity=${severity})`;
}

/**
 * Default Discord poster: boots a minimal-intents client, posts, tears
 * down. Fail-open — caller (`mainWithDeps`) catches and logs; a Discord
 * 503 must NOT crash the cron and trip PM2 backoff.
 */
async function postViaDiscord(message: string): Promise<void> {
  const token = process.env[DISCORD_TOKEN_ENV];
  if (!token) {
    console.warn(
      `[drift-scan-run] ${DISCORD_TOKEN_ENV} unset — would have posted:\n${message}`,
    );
    return;
  }

  const trimmed =
    message.length > MESSAGE_CHAR_BUDGET
      ? message.slice(0, MESSAGE_CHAR_BUDGET) + '…'
      : message;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', async () => {
        try {
          const channel = await client.channels.fetch(IFLEET_CHANNEL_ID);
          if (!channel || !('send' in channel)) {
            throw new Error(
              `[drift-scan-run] channel ${IFLEET_CHANNEL_ID} is not a text channel`,
            );
          }
          await (channel as TextChannel).send(trimmed);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  } finally {
    try {
      await client.destroy();
    } catch (err) {
      console.warn(
        `[drift-scan-run] discord client destroy failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Pure orchestration with injected deps. The PM2 entrypoint passes the
 * real `runDriftScan` + `postViaDiscord`; tests pass spies.
 *
 * Returns a process exit code. Always 0 today — fail-open everywhere so
 * a transient KG/Discord blip does not trip PM2 max_restarts.
 */
export async function mainWithDeps(deps: DriftScanDeps): Promise<number> {
  if (!envFlag(ENABLED_ENV)) {
    console.warn('[drift-scan-run] drift scan disabled (DRIFT_SCAN_ENABLED=0)');
    return 0;
  }

  if (!process.env[KG_URL_ENV]) {
    console.warn(
      `[drift-scan-run] ${KG_URL_ENV} unset — skipping scan (fail-open)`,
    );
    return 0;
  }

  const repos = getRepos();
  let result: DriftScanResult;
  try {
    result = await deps.runDriftScan({ repos });
  } catch (err) {
    // The substrate already catches KgPostgresUnavailableError internally
    // and returns an empty result, but a throw here (test injection or a
    // genuinely unexpected error) must NOT crash the cron. Skip the
    // Discord post — there's nothing meaningful to report.
    console.warn(
      `[drift-scan-run] runDriftScan threw: ${(err as Error).message}`,
    );
    return 0;
  }

  const message = formatMessage(result);
  try {
    await deps.postToDiscord(message);
  } catch (err) {
    console.warn(
      `[drift-scan-run] discord post failed (fail-open): ${(err as Error).message}`,
    );
  }
  return 0;
}

async function main(): Promise<void> {
  const code = await mainWithDeps({
    runDriftScan: (opts) => defaultRunDriftScan(opts),
    postToDiscord: postViaDiscord,
  });
  process.exit(code);
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return (
      argv1.endsWith('drift-scan-run.ts') ||
      argv1.endsWith('drift-scan-run.js')
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  void main();
}
