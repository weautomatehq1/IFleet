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

import { runProposer, type RunProposerDeps } from '../src/agents/proposer/index.js';
import type { ProposerConfig } from '../src/agents/proposer/types.js';
import { HmacControlPlaneClient } from '../src/discord/hmac-client.js';

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
const AUTO_APPROVE_THRESHOLD_ENV = 'IFLEET_PROPOSALS_AUTO_APPROVE_THRESHOLD';
const CONTROL_PLANE_URL_ENV = 'CONTROL_PLANE_URL';
const HMAC_SECRET_ENV = 'IFLEET_HMAC_SECRET';
const PROPOSALS_CHANNEL_ID_ENV = 'IFLEET_PROPOSALS_CHANNEL_ID';
const PROPOSALS_APPROVER_IDS_ENV = 'IFLEET_PROPOSALS_APPROVER_IDS';

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
  const rawThreshold = process.env[AUTO_APPROVE_THRESHOLD_ENV];
  if (rawThreshold !== undefined && rawThreshold.length > 0) {
    const parsed = Number(rawThreshold);
    if (Number.isFinite(parsed)) cfg.proposalsAutoApproveThreshold = parsed;
  }
  // Synthesize the Discord-source stamp the orchestrator handler requires on
  // every sprint_goal. Without both env vars the auto path silently falls
  // back to HITL inside splitAndDispatch — see auto-approve.ts.
  const proposalsChannel = process.env[PROPOSALS_CHANNEL_ID_ENV];
  const approverIds = (process.env[PROPOSALS_APPROVER_IDS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (proposalsChannel && approverIds.length > 0) {
    const threshold = cfg.proposalsAutoApproveThreshold ?? Number.POSITIVE_INFINITY;
    cfg.proposalsAutoApproveSource = {
      channelId: proposalsChannel,
      // The audit trail of "auto vs human" lives in goal_proposals.decided_by
      // (`auto-bandit-<threshold>`); the userId here just satisfies the
      // server-side ingest contract. Pick the first approver so any Discord
      // mention is at least a real human, not a broken `<@bot:...>` token.
      userId: approverIds[0]!,
      userLabel: `auto-bandit-${threshold}`,
    };
  }
  return cfg;
}

/**
 * Build the cross-cutting deps for `runProposer`. Returns `{}` when
 * CONTROL_PLANE_URL / IFLEET_HMAC_SECRET are unset — the orchestrator
 * gracefully falls back to HITL-only in that case so a smoke run can fire
 * without the daemon.
 */
function buildDeps(): RunProposerDeps {
  const url = process.env[CONTROL_PLANE_URL_ENV];
  const secret = process.env[HMAC_SECRET_ENV];
  if (!url || !secret) {
    console.warn(
      `[proposer-run] ${CONTROL_PLANE_URL_ENV} or ${HMAC_SECRET_ENV} unset — auto-approve disabled (HITL-only fallback)`,
    );
    return {};
  }
  return { controlPlane: new HmacControlPlaneClient({ url, secret }) };
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

  const deps = buildDeps();

  let exitCode = 0;
  for (const repoId of repoIds) {
    const cfg = buildConfig(repoId);
    console.warn(`[proposer-run] starting repoId=${repoId}`);
    try {
      const run = await runProposer(repoId, cfg, { deps });
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
