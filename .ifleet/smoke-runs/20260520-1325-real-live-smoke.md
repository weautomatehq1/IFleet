# Real live smoke — 2026-05-20 13:25 UTC

- **Split:** `~/.omc/splits/20260520-1145-audit-fixes` (T6)
- **Branch:** `chore/real-live-smoke-2026-05-20`
- **Worktree:** `/Users/Seb/dev/IFleet-real-smoke` (NEW, fresh off `origin/main`)
- **Base SHA:** `5f321f5` ("chore(pipeline): close PR #132 followups — classifier floor tests + constants from routing.json", PR #147)
- **Operator:** T6 (Opus 4.7), single-seat Max-plan policy respected
- **Predecessor:** `~/.omc/splits/20260520-0558-cleanup-adr-smoke` — its T5 was flagged in the brutal audit for verdict-inflated Smoke 2 + 3 (tests-as-production). This run closes audit Findings #1 + #2 with honest verdicts.

## Findings index (per T6 brief)

| Finding | Smoke | Verdict | Evidence type |
|---|---|---|---|
| (carried) Plan-reviewer floor | Smoke 1 | **PASS** | Direct `classifyTask()` invocation via committed script |
| #1 — Smoke 2 verdict inflation | Smoke 2 | **DEFERRED** | PM2 ecosystem hardcodes `/var/log/pm2` (sudo gated) + `.env` absent → no path to a real sprint without out-of-scope changes |
| #2 — Smoke 3 indexer never invoked | Smoke 3 | **DEFERRED-WITH-EVIDENCE** | `pnpm graph:index` invoked against real checkout; parsed 231 files; failed at upsert with `IFLEET_KG_DATABASE_URL is not set` |
| #7 — Stale `IFleet-m2-smoke` worktree | n/a | Recommend `git worktree remove /Users/Seb/dev/IFleet-m2-smoke` (branch is 108 lines diverged from main post-PR-#147) |

---

## Smoke 1 — Plan-reviewer floor holds

**Verdict: PASS.**

`classifyTask()` invoked directly via the committed reproducible script `scripts/smoke/classify-trace.mjs` against four representative tasks. Verbatim stdout from `node --import tsx scripts/smoke/classify-trace.mjs` at 2026-05-20 13:23:46 UTC:

```json
{
  "at": "2026-05-20T13:23:46.726Z",
  "rows": [
    {
      "name": "complexity:high + security keywords",
      "architect": "claude-opus-4-7",
      "editor": "claude-sonnet-4-6",
      "planReviewer": "claude-sonnet-4-6",
      "verify": "typecheck,lint,test"
    },
    {
      "name": "no high signal (UI polish)",
      "architect": "claude-haiku-4-5-20251001",
      "editor": "claude-sonnet-4-6",
      "planReviewer": "claude-haiku-4-5-20251001",
      "verify": "typecheck,lint,test"
    },
    {
      "name": "docs label only",
      "architect": "claude-haiku-4-5-20251001",
      "editor": "claude-sonnet-4-6",
      "planReviewer": "claude-haiku-4-5-20251001",
      "verify": "typecheck,lint,test"
    },
    {
      "name": "security keywords WITHOUT complexity:high",
      "architect": "claude-haiku-4-5-20251001",
      "editor": "claude-sonnet-4-6",
      "planReviewer": "claude-haiku-4-5-20251001",
      "verify": "typecheck,lint,test"
    }
  ]
}
```

Checked invariants:

| Invariant | Observed | Pass? |
|---|---|---|
| Editor is **never** Haiku — floored at Sonnet | every row → `claude-sonnet-4-6` | ✅ |
| Architect only promotes to Opus on explicit `complexity:high` | row 1 only → `claude-opus-4-7`; all others ≤ sonnet | ✅ |
| Plan-reviewer is **one tier below** the final architect tier (floor at the bottom of the tier ladder) | opus→sonnet on row 1; haiku→haiku on rows 2–4 (one-below of the bottom tier is the bottom tier) | ✅ |
| Verify steps include `test` for every auto:ship task | all rows include `typecheck,lint,test` | ✅ |

**Delta vs T5's table** (post-PR-#147 routing change): row 4 ("security keywords WITHOUT complexity:high") now lands the architect at Haiku, not Sonnet. T5 ran on `06f0730`, this run is on `5f321f5` which merged PR #147's classifier floor tests + tier constants refactor. The change is consistent with the explicit Phase B policy: *"opus burns the 5-hour Claude Max rate limit; only an explicit complexity:high label promotes the architect to opus"* (see `src/classifier/index.ts:201-205`). Keyword-only signal no longer auto-bumps the architect at all in the recent config — the floor rule still holds either way.

**Reproducer:** the smoke script is committed to `scripts/smoke/classify-trace.mjs` in this branch. Re-run with `node --import tsx scripts/smoke/classify-trace.mjs`. (Closes audit Finding "Smoke 1 evidence not reproducible — script not committed".)

---

## Smoke 2 — Veto loop fires

**Verdict: DEFERRED.** No test-suite fallback (per T6 brief's hard prohibition).

### Blocker chain

1. `pm2 list` shows only `discord-claude` running. `ifleet` is absent (matches T5's observation from earlier today).
2. `pm2 start ecosystem.config.cjs --only ifleet` fails:
   ```
   [PM2][WARN] Folder does not exist: /var/log/pm2
   [PM2] Creating folder: /var/log/pm2
   [PM2][ERROR] Could not create folder: /var/log/pm2
   [PM2][ERROR] Error: Could not create folder
   ```
   Root cause: `ecosystem.config.cjs:75-97` hardcodes log paths under `/var/log/pm2/*` — a VPS convention that requires root on macOS. T6 brief explicitly forbids modifying `ecosystem.config.cjs`, and `sudo mkdir /var/log/pm2` was denied by the workstation's policy classifier (escalates outside project scope).
3. Even if PM2 had started, the dev worktree has **no `.env` file** (only `.env.example`). The daemon would need `GITHUB_TOKEN`, Discord secrets, etc., none of which are present. No GitHub token → the queue poller can't read `auto:ship` issues → the veto loop cannot be exercised end-to-end.

### Honest evidence of "the veto loop *is* still real"

Quoting from `src/pipeline/runner.ts` (the path a real sprint takes — not a test fixture):

- `src/pipeline/plan-reviewer.ts` exports `runPlanReviewer` which the runner imports unconditionally.
- `src/pipeline/runner.ts:108-122` (verified at `5f321f5`) routes the reviewer's `vetoed` verdict back into a single re-plan attempt; a second veto escalates and prevents the editor from spawning.
- The exact log string the brief specifies (`[pipeline] plan-reviewer vetoed (attempt N/2): [kind] reason`) is emitted from `src/pipeline/plan-reviewer.ts` (grep confirms a single emitter call site, not duplicated in test fixtures).

This is **structural evidence**, not behavioral evidence — and the brief is clear that structural evidence is not a PASS for Smoke 2. Hence DEFERRED.

### What unblocks Smoke 2

The next operator who wants to convert this DEFERRED to a PASS needs one of:

1. **The fleet running on the VPS** (Hostinger box where `/var/log/pm2` exists + `.env` has real tokens) — open a sandbox issue per the brief, wait for the 5-minute poller tick, grep `~/.pm2/logs/ifleet-out.log`.
2. **A local override** — but that requires either (a) editing the ecosystem config to use a writable log path (forbidden in T6 scope), or (b) Sebastian explicitly granting sudo for `mkdir /var/log/pm2` so this dev box can run the daemon. Once unblocked, the rest of Smoke 2 (sandbox issue + log capture) is straightforward.

### Hard prohibition respected

Smoke 2 was **not** re-asserted by re-running `vitest src/pipeline/__tests__/plan-reviewer.test.ts`. Those tests already passed on PR #132's CI and PR #147's CI; they prove the runner code can veto under simulated inputs, not that the deployed system did veto under real inputs.

---

## Smoke 3 — KG indexer actually populates tables

**Verdict: DEFERRED-WITH-EVIDENCE.** The indexer CLI was invoked against a real checkout. It parsed 231 TS/TSX files, refused to write, and surfaced a clean structured error. This is *evidence the CLI behaves correctly under a credentials-missing boundary*, but it is not PASS evidence because no rows were upserted into `code_nodes` / `code_edges`.

### Pre-run row counts

Not captured. `IFLEET_KG_DATABASE_URL` is unset in both the worktree's `.env` (the file does not exist; only `.env.example` is present) and the shell environment. Without a connection string, `psql` cannot run, so a pre-run count would be vacuous.

### Invocation

```
$ cd /Users/Seb/dev/IFleet-real-smoke
$ pnpm graph:index ifleet /Users/Seb/dev/IFleet-real-smoke
```

### Verbatim stdout

```json
> ifleet@0.0.1 graph:index /Users/Seb/dev/IFleet-real-smoke
> node --import tsx scripts/index-repo.ts ifleet /Users/Seb/dev/IFleet-real-smoke

[graph:index] ifleet @ 5f321f5 — 231 TS/TSX files
{
  "repoId": "ifleet",
  "sha": "5f321f553b2c28b5ecd449e376a5876d4968bbc3",
  "filesParsed": 231,
  "filesSkipped": 0,
  "nodesUpserted": 0,
  "edgesUpserted": 0,
  "embeddingsRequested": 0,
  "embeddingsCached": 0,
  "durationMs": 666,
  "errors": [
    {
      "path": "<infra>",
      "stage": "io",
      "message": "IFLEET_KG_DATABASE_URL is not set. Copy .env.example and fill the Supabase connection string (ADR-0003 has the project name: ifleet-kg)."
    }
  ]
}
```

### What this evidence *does* and *does not* prove

| Question | Answered? | Source |
|---|---|---|
| Does the CLI parser walk the repo correctly? | ✅ Yes — 231 TS/TSX files parsed, 0 skipped, 666 ms | stdout above |
| Does the CLI surface a clean structured error when Postgres creds are absent? | ✅ Yes — the `KgPostgresUnavailableError` path documented in `src/agents/indexer/README.md:64-65` fires and is captured in the `errors[]` array, not thrown to stderr | stdout above |
| Does the upsert pipeline actually write rows to `code_nodes`, `code_edges`? | ❌ Unproven — `nodesUpserted: 0`, `edgesUpserted: 0` because the connection short-circuits at the IO stage | stdout above |
| Does the `voyage-code-3` embedding pipeline actually populate `code_nodes.embedding`? | ❌ Unproven — `embeddingsRequested: 0` (the symbolic-only path also short-circuits when upsert is gated) | stdout above |

### Post-run row counts

Not captured — same blocker.

### What unblocks Smoke 3

A `.env` file in the worktree (or shell-exported equivalents) with:

- `IFLEET_KG_DATABASE_URL` — the Supabase `ifleet-kg` project's direct connection string (ADR-0003). Without it, no upsert path can run.
- `VOYAGE_API_KEY` — to make `embeddingsRequested > 0`. Without it, the run still validates the symbolic-only path documented in `README.md:67`, which is a valuable PASS-with-caveat verdict but is not the full one the brief asks for.

Once the env is in place, re-run the four steps from the T6 brief (psql pre-count → `pnpm graph:index` → psql post-count → row samples + embedding-not-null count). The pre-count + invocation + post-count delta is the PASS evidence.

### Hard prohibition respected

Smoke 3 was **not** re-asserted by re-running `vitest src/agents/indexer/__tests__/*.ts`. Those tests already pass; they don't prove the deployed CLI populates Postgres under real creds.

---

## Stale-worktree recommendation (Finding #7)

`git worktree list` (at smoke time) shows:

```
/Users/Seb/dev/IFleet-m2-smoke      57f891b [chore/m2-kg-live-smoke-evidence]
```

This was T5's worktree, branched off `06f0730` *before* PR #147 landed on main (`5f321f5`). The branch is now 108 lines behind main and serves no purpose — its smoke evidence is superseded by this file. Recommended cleanup:

```
git worktree remove /Users/Seb/dev/IFleet-m2-smoke
git branch -d chore/m2-kg-live-smoke-evidence   # if the remote copy is retained for history
```

(Per the T6 brief, T6 does NOT execute the cleanup — T1 handles worktree removal.)

---

## Surprises

1. **PM2 ecosystem is VPS-only by design.** `ecosystem.config.cjs:75-97` hardcodes `/var/log/pm2/*` log paths. Running the fleet locally on a dev workstation requires either `sudo mkdir /var/log/pm2 && chown $USER` (out of T6 scope) or an ecosystem-config split (which would be a separate PR — not a smoke artifact). This explains why T5 also hit "PM2 ifleet not running" — it's not a regression, it's the topology choice.
2. **The KG indexer's error reporting is clean.** Rather than throwing on missing `IFLEET_KG_DATABASE_URL`, the CLI returns a structured `IndexResult` with the error captured under `errors[]`. That's friendly to programmatic callers — a downstream cron can detect the misconfiguration without parsing exception text. (Visible from the verbatim stdout above.)
3. **Classifier routing drifted between T5 (06f0730) and T6 (5f321f5).** Row 4 of the floor table now scores Haiku for the architect on security-keyword-only input where T5 saw Sonnet. PR #147 introduced no semantic change to the floor itself — it lifted tier constants out of the function body and added explicit floor tests — but it did remove the keyword-only sonnet bump that was implicit in older code. The floor invariant (editor ≥ sonnet, architect only opus on `complexity:high`) survives unchanged.
4. **The committed Smoke 1 script will now self-document the floor invariant on every run.** Closes the audit gripe that T5's evidence was unreproducible.

---

## Plain-language recap

T6 was sent to redo two of T5's smoke results because the audit caught T5 calling unit-test runs "PASS" for things that needed a real running system to prove.

What T6 found and did:

1. **The router that picks AI models** (the "floor" rule that says "never pick a dumber editor than Sonnet"): re-confirmed PASS using a tiny script that calls the real router function with four sample inputs and prints the result. The script is now committed under `scripts/smoke/classify-trace.mjs` so anyone can re-run it in 5 seconds.

2. **The "if the plan is bad, throw it back and re-plan" loop:** the brief said "prove it by getting a real sprint to do this, no shortcuts." On this dev workstation, the fleet can't actually start — its log directory is hardcoded to a VPS-only path (`/var/log/pm2`), and the dev worktree has no GitHub token. T6 reports this honestly as **DEFERRED**, not PASS, with the exact blocker named. To get a real PASS later, run the sprint on the VPS or grant the dev box permission to create the log folder.

3. **The "knowledge graph indexer puts code into Postgres" feature:** T6 actually ran the CLI against the real IFleet checkout. It parsed all 231 TypeScript files, then refused to write to Postgres because the database password isn't set in this worktree (no `.env` file). That's actually a positive signal — the CLI fails *cleanly* with a structured error, not a crash — but it's **DEFERRED** for the "rows in the database" part because no rows actually landed. Unblock by adding `IFLEET_KG_DATABASE_URL` to the worktree's `.env` and re-running.

4. **Recommended cleanup:** the leftover T5 worktree at `IFleet-m2-smoke` is now stale (108 lines behind main); flagged for T1 to remove.

In short: 1 honest PASS, 2 honest DEFERRED. No tests-as-production substitution. Both DEFERRED items have a one-step unblock path documented.
