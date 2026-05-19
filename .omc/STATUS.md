# STATUS — IFleet

Last updated: 2026-05-19

---

## Done (recent)

- [overnight-2026-05-18] ✅ T1–T4 + T5 cleanup shipped: PRs #101 (doctor self-heal), #102 (pipeline learnings + deep-interview), #103 (MCP server), #104 (classifier modes + auto-router), #105 (T5 chore: briefs + lint cleanup). Issue #98 closed.
- [mcp-server] ✅ MCP stdio server with submitSprint/getSprint/cancelSprint/listActive (#70 via PR #103); stdio-clean boot verified
- [classifier-modes-auto-router] ✅ per-task SprintMode (ralph/ulw/tdd/deslop/standard) + Haiku auto-router with 5s timeout + kill switch (#72/#75 via PR #104)
- [pipeline-learnings-interview] ✅ per-repo .omc/learnings.md read+append in architect, deep-interview phase for vague briefs (#69/#71 via PR #102)
- [doctor-self-heal] ✅ doctor extension — fingerprint matching (.omc/fingerprints.json), 30-min Haiku scan, daily 06:00 learnings rollup; PM2 entry off by default (#76)
- [brief-library] ✅ docs/briefs/ seeded with 11 real examples + frontmatter contract (via PR #105)
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

- (none — overnight push 2026-05-18 cleared the queue; #106–#109 are T5 followups, priority:low)

## Up next

- #106 fix(mcp): swap submitSprint mode literal to use classifier SprintMode
- #107 fix(classifier): detectExplicitMode does not match HTML-commented mode directives from MCP
- #108 chore: add scripts/ to tsconfig include for ts-prune coverage
- #109 feat(observability): route haiku-gate-passed through event log instead of console.warn

## Blocked

- (none currently)
