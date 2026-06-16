// PM2 one-shot cron entry for the M5 Proposer (see ecosystem.config.cjs,
// app `ifleet-proposer`). Fires nightly per the cron_restart schedule, runs
// runProposer for each repo in PROPOSER_REPO_IDS, logs the result, exits.
//
// Off by default — gated on `PROPOSER_ENABLED=1`. Until T4 + T5 land, the
// downstream stages throw and this script will exit non-zero. That's by
// design: autorestart is false so a single failed run won't loop.
//
// Manual trigger (development):
//   PROPOSER_ENABLED=1 PROPOSER_REPO_IDS=weautomatehq1/IFleet \
//     PROPOSER_REPO_ROOT=$PWD node --import tsx scripts/proposer-run.ts

import { resolve } from 'node:path';

import { Client, GatewayIntentBits } from 'discord.js';

import { registerProposerDiscordClient } from '../src/agents/proposer/approval-gate.js';
import type { ContextLoaderDeps } from '../src/agents/proposer/context-loader.js';
import { runProposer } from '../src/agents/proposer/index.js';
import type {
  PrDecisionSummary,
  ProposerConfig,
} from '../src/agents/proposer/types.js';
import { getPastProposalsByRepo } from '../src/orchestrator/goal-proposals-store.js';
import { TaskStore, defaultTasksDbPath } from '../src/queue/store.js';

const ENABLED_ENV = 'PROPOSER_ENABLED';
const REPO_IDS_ENV = 'PROPOSER_REPO_IDS';
const REPO_ROOT_ENV = 'PROPOSER_REPO_ROOT';
const BUDGET_ENV = 'PROPOSER_BUDGET';
const HARD_MAX_ENV = 'PROPOSER_HARD_MAX';
const WINDOW_DAYS_ENV = 'PROPOSER_WINDOW_DAYS';
const DEDUP_THRESHOLD_ENV = 'PROPOSER_DEDUP_THRESHOLD';
const EMBEDDING_MODEL_ENV = 'PROPOSER_EMBEDDING_MODEL';
const DISCORD_CHANNEL_ENV = 'PROPOSER_DISCORD_CHANNEL_ID';
const DRY_RUN_ENV = 'PROPOSER_DRY_RUN';
const DISCORD_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
const TASKS_DB_ENV = 'IFLEET_TASKS_DB';

const DEFAULTS = {
  budget: 3,
  hardMax: 10,
  windowDays: 7,
  pastProposalsWindowDays: 30,
  dedupThreshold: 0.85,
  embeddingModel: 'text-embedding-3-small',
} as const;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === '1' || raw === 'true';
}

function buildConfig(repoId: string): ProposerConfig {
  const repoRoot = process.env[REPO_ROOT_ENV] ?? resolve(process.cwd());
  const cfg: ProposerConfig = {
    repoId,
    repoRoot,
    budget: envNumber(BUDGET_ENV, DEFAULTS.budget),
    hardMax: envNumber(HARD_MAX_ENV, DEFAULTS.hardMax),
    windowDays: envNumber(WINDOW_DAYS_ENV, DEFAULTS.windowDays),
    pastProposalsWindowDays: DEFAULTS.pastProposalsWindowDays,
    dedupThreshold: envNumber(DEDUP_THRESHOLD_ENV, DEFAULTS.dedupThreshold),
    embeddingModel: process.env[EMBEDDING_MODEL_ENV] ?? DEFAULTS.embeddingModel,
  };
  const channel = process.env[DISCORD_CHANNEL_ENV];
  if (channel) cfg.discordChannelId = channel;
  if (envFlag(DRY_RUN_ENV)) cfg.dryRun = true;
  return cfg;
}

/**
 * Boot a discord.js Client for the proposer cron process and register it on
 * the approval-gate seam. AUDIT-IFleet-2057d021: the proposer runs as the
 * `ifleet-proposer` PM2 app, a SEPARATE node process from the long-running
 * `ifleet` daemon. The daemon's `registerProposerDiscordClient(client)` call
 * never crosses into this process, so the cron must do its own login or every
 * nightly run posts zero proposals.
 *
 * Returns null when DISCORD_BOT_TOKEN is unset — the approval-gate will then
 * take the "no Discord client" branch and the run becomes a dry log. Useful in
 * smoke tests and during the M5 feature-flag rollout.
 */
export async function bootDiscordClient(
  token: string | undefined,
): Promise<Client | null> {
  if (!token) {
    console.warn(
      `[proposer-run] ${DISCORD_TOKEN_ENV} unset — Discord posting will be skipped`,
    );
    return null;
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  await client.login(token);
  registerProposerDiscordClient(client);
  return client;
}

/**
 * Subset of TaskStore the proposer cron needs — narrow so tests can pass a
 * plain object instead of constructing a SQLite db.
 */
export interface PrDecisionsReader {
  getPrDecisionsByRepo(repo: string, limit: number): PrDecisionSummary[];
}

/**
 * Wire the real read paths the context-loader documents (see
 * src/agents/proposer/context-loader.ts:46-69). AUDIT-IFleet-322a2854: the
 * cron was calling `runProposer(repoId, cfg)` with no third argument, leaving
 * both readers undefined and silently disabling the DO-NOT-REPEAT past-title
 * guard, history-aware dedupe, and the Voyager "see what we tried" loop
 * (M5.2-T2, PR #352). Production must hand the loader these two readers.
 */
export function buildContextDeps(store: PrDecisionsReader): ContextLoaderDeps {
  return {
    prDecisionsByRepo: (repoId, limit) =>
      store.getPrDecisionsByRepo(repoId, limit),
    pastProposalsByRepo: (repoId, limit) =>
      getPastProposalsByRepo(repoId, limit),
  };
}

async function main(): Promise<void> {
  if (!envFlag(ENABLED_ENV)) {
    console.warn(`[proposer-run] ${ENABLED_ENV} not set — skipping nightly run`);
    return;
  }

  const repoIds = (process.env[REPO_IDS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (repoIds.length === 0) {
    console.warn(`[proposer-run] ${REPO_IDS_ENV} empty — nothing to do`);
    return;
  }

  let discordClient: Client | null = null;
  let exitCode = 0;
  try {
    discordClient = await bootDiscordClient(process.env[DISCORD_TOKEN_ENV]);
    const store = new TaskStore(process.env[TASKS_DB_ENV] ?? defaultTasksDbPath());
    const contextDeps = buildContextDeps(store);

    for (const repoId of repoIds) {
      const cfg = buildConfig(repoId);
      console.warn(`[proposer-run] starting repoId=${repoId}`);
      try {
        const run = await runProposer(repoId, cfg, { contextDeps });
        console.warn(
          `[proposer-run] done repoId=${repoId} runId=${run.runId} candidates=${run.candidates.length} posted=${run.posted}`,
        );
      } catch (err) {
        exitCode = 1;
        console.warn(
          `[proposer-run] FAILED repoId=${repoId}: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    // Discord client holds an open websocket; cron must release it so the
    // PM2 one-shot process can exit cleanly.
    if (discordClient) {
      try {
        await discordClient.destroy();
      } catch (err) {
        console.warn(
          `[proposer-run] discord client destroy failed: ${(err as Error).message}`,
        );
      }
    }
  }
  process.exit(exitCode);
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.endsWith('proposer-run.ts') || argv1.endsWith('proposer-run.js');
  } catch {
    return false;
  }
})();
if (isMain) {
  void main();
}
