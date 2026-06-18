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

import { planDriftPrs } from '../src/agents/drift-detector/real-pr.js';
import type { DriftPrPlan } from '../src/agents/drift-detector/real-pr.js';
import { runDriftScan as defaultRunDriftScan } from '../src/agents/drift-detector/scan.js';
import type {
  DriftCandidate,
  DriftScanResult,
} from '../src/agents/drift-detector/types.js';
import {
  SqliteDriftIdempotencyStore,
  type DriftIdempotencyStore,
} from '../src/agents/drift-detector/idempotency-store.js';

const ENABLED_ENV = 'DRIFT_SCAN_ENABLED';
const KG_URL_ENV = 'IFLEET_KG_DATABASE_URL';
const DISCORD_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
const REPOS_ENV = 'DRIFT_SCAN_REPOS';

// M6 closure flag — OFF by default. When OFF the scan stays report-only
// (post the digest, stop). When ON the flagged drift candidates additionally
// route to the real candidate-PR path (one plan per source-of-truth repo).
// Flip only after the candidate-merge-rate KPI clears ≥70%.
const REAL_PR_ENV = 'DRIFT_REAL_PR';

// Same constant as standup.ts — #ifleet.
const IFLEET_CHANNEL_ID = '1504120127791042631';

// Discord 2000-char hard limit; cap bullets to keep us well under it.
const MAX_BULLETS = 25;
const MESSAGE_CHAR_BUDGET = 1990;

const DEFAULT_REPOS = ['weautomatehq1/IFleet', 'weautomatehq1/factory'];

export interface DriftScanDeps {
  runDriftScan: (opts: { repos: string[] }) => Promise<DriftScanResult>;
  postToDiscord: (message: string) => Promise<void>;
  /**
   * Real candidate-PR emitter. Only invoked when `DRIFT_REAL_PR` is ON and
   * the scan produced ≥1 plan. Optional so the report-only path (and every
   * existing caller/test) is unaffected. Per the architecture rule the
   * default emitter does NOT call GitHub directly — it hands plans to the
   * bridge layer (stubbed today; see `emitDriftPrsStub`).
   */
  emitDriftPrs?: (plans: DriftPrPlan[]) => Promise<void>;
  /**
   * Idempotency store for the real-PR path. The cron filters every plan
   * through `wasEmitted(plan.idempotencyKey)` before handing it to the
   * emitter and calls `markEmitted` after a successful emit, so a re-run
   * with the same drift signature does NOT open a second PR. Optional so
   * tests and the OFF path stay free of SQLite setup; the default
   * `mainWithDeps` caller injects a `SqliteDriftIdempotencyStore`.
   */
  idempotencyStore?: DriftIdempotencyStore;
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

  // ---- DRIFT_REAL_PR gated branch (OFF by default) ----------------------
  // OFF: nothing happens here — the report-only path above is the whole
  // behavior (byte-identical to pre-flag main). ON: route flagged drift
  // candidates to the real candidate-PR path. Fail-open — a PR-emit hiccup
  // must not crash the cron or trip PM2 backoff.
  if (envFlag(REAL_PR_ENV)) {
    const plans = planDriftPrs(result);
    if (plans.length === 0) {
      console.warn(
        '[drift-scan-run] DRIFT_REAL_PR on but scan produced no drift plans — nothing to open',
      );
      return 0;
    }

    // Idempotency gate: filter out any plan whose per-source-file-SHA key
    // has already been emitted. Re-running the cron on identical drift
    // becomes a no-op rather than reopening the same PR. The store is
    // optional so tests (and any caller that opts out) just see every
    // plan flow through.
    const store = deps.idempotencyStore;
    const fresh: DriftPrPlan[] = [];
    const skipped: DriftPrPlan[] = [];
    if (store) {
      for (const p of plans) {
        if (store.wasEmitted(p.idempotencyKey)) skipped.push(p);
        else fresh.push(p);
      }
    } else {
      fresh.push(...plans);
    }

    if (skipped.length > 0) {
      console.warn(
        `[drift-scan-run] skipping ${skipped.length} drift plan(s) — already emitted (idempotent re-run)`,
      );
    }

    if (fresh.length === 0) {
      console.warn(
        '[drift-scan-run] DRIFT_REAL_PR on but every plan was already emitted — nothing new to open',
      );
      return 0;
    }

    const emit = deps.emitDriftPrs ?? emitDriftPrsStub;
    try {
      await emit(fresh);
      // Mark only after the emit resolves so an emit-error leaves the
      // store untouched and the next cron tick will retry. Each markEmitted
      // is wrapped so a single bad row never aborts the loop.
      if (store) {
        const now = Date.now();
        for (const p of fresh) {
          try {
            store.markEmitted(p.idempotencyKey, {
              sourceRepo: p.sourceRepo,
              emittedAt: now,
            });
          } catch (markErr) {
            console.warn(
              `[drift-scan-run] markEmitted failed for ${p.sourceRepo} (fail-open): ${(markErr as Error).message}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `[drift-scan-run] drift-PR emit failed (fail-open): ${(err as Error).message}`,
      );
    }
  }

  return 0;
}

/**
 * Default real-PR emitter. The bridge wiring (emit a candidate-PR event per
 * plan, let the queue bridge open the PR) is a follow-up — the architecture
 * rule forbids calling GitHub from here. Until that lands this stub logs what
 * WOULD be opened so an operator flipping the flag sees the plans. Safe
 * because `DRIFT_REAL_PR` defaults OFF.
 */
async function emitDriftPrsStub(plans: DriftPrPlan[]): Promise<void> {
  for (const p of plans) {
    console.warn(
      `[drift-scan-run] DRIFT_REAL_PR would open candidate PR — source=${p.sourceRepo} ` +
        `symbols=${p.candidates.length} targets=${p.targetRepos.join(',') || '(none)'} ` +
        `labels=${p.labels.join(',')} key=${p.idempotencyKey.slice(0, 12)}… ` +
        `(bridge emit not yet wired)`,
    );
  }
}

async function main(): Promise<void> {
  // Open the real idempotency store only when DRIFT_REAL_PR is ON so the
  // OFF path never touches SQLite. The store is kept alive for the entire
  // mainWithDeps run and closed once the cron settles.
  const realPrOn = process.env[REAL_PR_ENV] === '1' || process.env[REAL_PR_ENV] === 'true';
  const idempotencyStore = realPrOn ? new SqliteDriftIdempotencyStore() : undefined;
  try {
    const code = await mainWithDeps({
      runDriftScan: (opts) => defaultRunDriftScan(opts),
      postToDiscord: postViaDiscord,
      idempotencyStore,
    });
    process.exit(code);
  } finally {
    try {
      idempotencyStore?.close?.();
    } catch (err) {
      console.warn(
        `[drift-scan-run] idempotency store close failed: ${(err as Error).message}`,
      );
    }
  }
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
