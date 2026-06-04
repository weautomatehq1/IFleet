# SECURITY — IFleet protected paths and rules

> Loaded by global CLAUDE.md continuous execution rule. Any agent touching a protected path must escalate to a human, never auto-execute.

## Protected paths (no agent auto-write)

These files/directories are load-bearing for IFleet's operation or contain secrets. Modifications require human approval; agents must propose a diff and pause, never push.

| Path | Why protected |
|---|---|
| `.env`, `.env.*` (except `.env.example`) | Secrets — Discord bot token, Claude API key, HMAC secret, GitHub token |
| `ecosystem.config.cjs` | PM2 process config — controls VPS daemon lifecycle |
| `nginx/**` | Reverse proxy config — wrong rule = control plane unreachable |
| `deploy/deploy.sh`, `deploy/install-vps.sh`, `deploy/env.example`, `deploy/README.md` | VPS deployment scripts — direct path to production |
| `src/server.ts` | HMAC verification, Discord webhook entry — auth boundary |
| `src/orchestrator/sprint.ts` | SprintManager — the trace owner; corruption breaks everything |
| `src/orchestrator/store.ts` | SQLite state — task state + idempotency dedup |
| `src/queue/**` | GitHub bridge — the ONLY layer allowed to call GitHub API |
| `config/routing.json` | Live model routing — wrong edit costs money or breaks pipeline |
| `config/channels.json` | Discord ACL — `allowedUserIds` controls who can issue fleet commands |
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

## Replay protection (control plane)

Signed control-plane requests carry an HMAC + timestamp + nonce. The nonce
ledger is persisted to SQLite (`nonce_ledger` table on the shared tasks DB)
as of AUDIT-IFleet-e664f9f3 closure; replay protection now survives
control-plane restart. Before this change, an in-process Map held the
ledger and a PM2 restart wiped it, letting any captured signed request
with a timestamp inside the 5-minute skew window be replayed against the
freshly-started process.

**Atomic prune + insert (PR #334 / AUDIT-IFleet-cf106efc, 2026-06-04).**
`SqliteNonceLedger.registerOrReject` wraps the prune-expired + `INSERT OR
IGNORE` pair inside a single `BEGIN IMMEDIATE` transaction (better-sqlite3
`txn.immediate(...)`). The IMMEDIATE lock serialises writers across
processes sharing the SQLite file, and `result.changes === 1` IS the
fresh-or-replay decision — the duplicate is caught by the SQLite UNIQUE
constraint on `nonce_ledger.nonce` without any pre-insert SELECT. Two
control-plane instances racing on the same DB cannot both observe the
nonce as fresh; regression covered by `src/queue/__tests__/store.test.ts`
(`SqliteNonceLedger` suite).

PR #319 had moved the decision off SELECT-then-INSERT onto `INSERT OR
IGNORE`'s `result.changes` but left the prune + insert as two unwrapped
statements, so a concurrent writer could still slip a duplicate row in
between. The IMMEDIATE transaction added here closes that window.

The single-seat deployment policy in `docs/running.md` still applies for
other reasons (Max-plan quota, queue ownership), but the nonce ledger is
no longer the load-bearing reason multi-instance is unsafe.

## Secret handling

- No secrets in JSON config files. Always env vars or `.env` (gitignored).
- No secrets in `learnings.md`, briefs, or traces. Sanitize before persisting.
- HMAC secret rotation: see `docs/runbooks/hmac-rotation.md`.

## Threat model (brief)

- **Discord token leak** → adversary posts to mapped channels → `/ship` runs on attacker prompts. Mitigation: `allowedUserIds` per channel + HMAC on bot↔control-plane.
- **GitHub PAT leak** → adversary opens malicious PRs → bypasses `allowedUserIds`. Mitigation: PAT is fine-grained, scoped to specific repos, no admin.
- **Compromised dep (npm supply chain)** → arbitrary code in our process. Mitigation: pnpm lockfile committed (root + nested), enforced locally via `pnpm install --frozen-lockfile`. TODO M1 — wire `pnpm audit --audit-level=high` (or equivalent `npm audit` given `.github/workflows/ci.yml` currently installs via `npm ci --no-audit`) as a non-blocking CI step; this PR did not ship the CI step because adding a new audit job warrants Sebastian's sign-off on the failure-blocking policy.
- **Self-modification gone wrong** → IFleet writes a bug into itself, propagates. Mitigation: SECURITY.md + shadow eval + human approval gate (above).
- **Single Discord operator (control plane SPOF)** → both `factory` and `ifleet` channels in
  `config/channels.json` gate on one Discord user ID (`1503477896402960405`, Sebastian).
  If that account is compromised, locked, or unavailable, no Discord commands can be issued.
  Mitigation (partial): HMAC still protects the HTTP entry point; the gap is Discord-to-control-plane
  only, not the queue or GitHub bridge.
  Remediation path: add Esme's Discord snowflake ID to `allowedUserIds` in both channel entries —
  her operator status is documented in `docs/runbooks/secrets.md` and `config/repos.json`.
  Tracked: AUDIT-IFleet-6a1cdff1. Open follow-on issue once ID is confirmed.

## Reporting

- Suspected secret exposure → rotate immediately, document in `memory/handoff.md` under Incidents.
- Suspected agent misuse (prompt injection via PR description, issue body, etc.) → cancel sprint, document, file issue.
