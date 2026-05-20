# SECURITY — IFleet protected paths and rules

> Loaded by global CLAUDE.md continuous execution rule. Any agent touching a protected path must escalate to a human, never auto-execute.

## Protected paths (no agent auto-write)

These files/directories are load-bearing for IFleet's operation or contain secrets. Modifications require human approval; agents must propose a diff and pause, never push.

| Path | Why protected |
|---|---|
| `.env`, `.env.*` (except `.env.example`) | Secrets — Discord bot token, Claude API key, HMAC secret, GitHub token, Sentry DSN |
| `ecosystem.config.cjs` | PM2 process config — controls VPS daemon lifecycle |
| `nginx/**` | Reverse proxy config — wrong rule = control plane unreachable |
| `deploy/deploy.sh`, `deploy/install-vps.sh`, `deploy/env.example`, `deploy/README.md` | VPS deployment scripts — direct path to production |
| `src/server.ts` | HMAC verification, Discord webhook entry — auth boundary |
| `src/orchestrator/sprint.ts` | SprintManager — the trace owner; corruption breaks everything |
| `src/orchestrator/store.ts` | SQLite state — task state + idempotency dedup |
| `src/queue/**` | GitHub bridge — the ONLY layer allowed to call GitHub API |
| `config/routing.json` | Live model routing — wrong edit costs money or breaks pipeline |
| `docs/adr/**` | Architecture Decision Records — immutable, only superseded |

### Carve-outs (agent-writable under stricter rules)

| Path | Rule |
|---|---|
| `deploy/postgres/**` | Knowledge-graph schema migrations. Agents MAY add new `NNNN-*.sql` files. **Additive only** — never `DROP`, `TRUNCATE`, `DELETE`, `ALTER ... DROP`, or any destructive statement. Renames must use `ALTER TABLE ... RENAME` (still additive). One migration per PR. Forward-only — to revert, write a new additive migration. |

## Self-modification constraints (for IFleet→IFleet PRs, M4+)

When IFleet proposes changes to its own codebase (`weautomatehq1/IFleet`):

1. **Never** touch any path in the table above.
2. **Maximum 5 files changed and 300 lines diff** per self-improvement PR.
3. **Human approval required** — `auto-merge` is disabled for any PR with label `ifleet:self`.
4. **Shadow eval required** — candidate code runs against `.ifleet/eval/eval-set.jsonl` (≥50 tasks) and must match or beat baseline on all metrics before approval.
5. **Rollback ready** — every self-PR must be revertable via single `pm2 reload ecosystem.config.cjs --update-env` against prior git tag.

## Secret handling

- No secrets in JSON config files. Always env vars or `.env` (gitignored).
- No secrets in `learnings.md`, briefs, or traces. Sanitize before persisting.
- HMAC secret rotation: documented in `docs/runbooks/` (TODO M0.W2).

## Threat model (brief)

- **Discord token leak** → adversary posts to mapped channels → `/ship` runs on attacker prompts. Mitigation: `allowedUserIds` per channel + HMAC on bot↔control-plane.
- **GitHub PAT leak** → adversary opens malicious PRs → bypasses `allowedUserIds`. Mitigation: PAT is fine-grained, scoped to specific repos, no admin.
- **Compromised dep (npm supply chain)** → arbitrary code in our process. Mitigation: pnpm lockfile + `pnpm audit` in CI (TODO M1).
- **Self-modification gone wrong** → IFleet writes a bug into itself, propagates. Mitigation: SECURITY.md + shadow eval + human approval gate (above).

## Reporting

- Suspected secret exposure → rotate immediately, document in `memory/handoff.md` under Incidents.
- Suspected agent misuse (prompt injection via PR description, issue body, etc.) → cancel sprint, document, file issue.
