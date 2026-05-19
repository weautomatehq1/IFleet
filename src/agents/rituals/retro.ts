/**
 * Weekly retro generator.
 *
 * TODO M5+: This stub exists so the ecosystem.config.cjs cron entry can be
 * wired now. The retro fires at Sunday 8pm but exits early until M5 data
 * (pr_decisions, goal_proposals, 7-day cost aggregation) is available.
 *
 * When M5 lands:
 *   1. Replace this stub with real data queries.
 *   2. Post to #ifleet-ops channel.
 *   3. Enable the `ifleet-retro` PM2 app in ecosystem.config.cjs (autorestart: true).
 */

export async function postRetro(): Promise<void> {
  console.warn('[retro] M5+ data not yet available — skipping retro post.');
}

const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith('retro.ts') || arg.endsWith('retro.js');
})();

if (isEntryPoint) {
  postRetro().catch((err) => {
    console.error('[retro] failed:', err);
    process.exit(1);
  });
}
