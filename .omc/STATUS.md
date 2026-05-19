# STATUS — IFleet

Last updated: 2026-05-15

---

## Done (recent)

- [doctor-self-heal] ✅ doctor extension — fingerprint matching (.omc/fingerprints.json), 30-min Haiku scan, daily 06:00 learnings rollup; PM2 entry off by default (#76)
- [sentry-n8n-bridge] ✅ Sentry → n8n → GitHub Issues pipeline wired and verified 2026-05-15
- [discord-notifications] ✅ PR #79 — sprint start/success/failure notifications to #ifleet
- [discord-webhook-env] ✅ DISCORD_IFLEET_WEBHOOK set in .env, PM2 reloaded
- [in-flight-cleanup] ✅ stripped stale in_flight labels from #69 #70 #76 after connect timeout
- [architect-complexity-label] ✅ PR #41 merged — complexity:high gates opus, sonnet default
- [reviewer-haiku-cost-split] ✅ PR #74 (merged)
- [classifier-sonnet-floor] ✅ editor + empty-diff guard PR #73
- [pipeline-cross-provider-relax] ✅ PR #67/#68 — warn in single-provider pools
- [factory-adapter-registry] ✅ PR #65 — wire adapter registry + repos config
- [sprint-exit-codes] ✅ PR #64 — route exit codes 2+3 to cancel/blocked
- [pm2-ops] ✅ PR #63 — DISCORD_IFLEET_WEBHOOK + BUDGET_USD env
- [phase-1-factory] ✅ PR #62 — items 1-5, 7, 8, 10, 11
- [single-seat-policy] ✅ PR #60 — single-seat Max-plan policy documented

## In flight (fleet-owned)

- #69 feat(learnings): read and append per-repo learnings in architect phase
- #70 feat(mcp): MCP server exposing submitSprint, getSprint, cancelSprint, listActive
- #71 feat(pipeline): deep-interview phase for vague briefs
- #72 feat(classifier): sprint mode routing — ralph/ulw/tdd/deslop labels
- #75 feat(orchestrator): auto-router — Haiku sprint mode selector

## Up next

- [brief-library] — populate docs/briefs/ so auto-router has examples to learn from

## Blocked

- (none currently)
