## Summary

- Replaces GitHub-Issue-driven polling with a Discord-first architecture: slash commands in `#ifleet` queue tasks, architect plan posted as embed with Approve/Reject/Cancel buttons, pipeline resumes on tap
- Adds VPS daemon (`src/orchestrator/daemon.ts`) with two PM2 apps: `control-plane` (port 3001, public via nginx TLS) + `ifleet` (port 3002, localhost ControlPlane + discord.js client)
- Wires `UnifiedQueueAdapter` → `DiscordOutAdapter` → `ControlPlaneApprovalGate` end-to-end; shared SQLite store with stale-task recovery on boot
- Adds `deploy/install-vps.sh` (idempotent bootstrap) + `deploy/deploy.sh` (rsync + pm2 reload)
- Security: HMAC-signed `/control` endpoint, env scrubbing for Claude subprocesses, unmapped-channel denial, rootDir escape fix

## Commits

16 commits — 2 cleanup/review rounds, 35 findings closed, final P0 wire-format fix in `98b9fed`.

## Test plan

- [ ] `pnpm tsc --noEmit` exits 0
- [ ] `pnpm test` — 250 node-test + 223 vitest green
- [ ] VPS bootstrap: `bash deploy/install-vps.sh` idempotent
- [ ] `curl -fsS https://control.weautomatehq.cloud/healthz` → `{"ok":true}`
- [ ] Phone smoke test: `/ship` in `#ifleet` → thread → approve button → PR opens

## Out of scope

Stripe, multi-tenant, user signup — see `CLAUDE.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
