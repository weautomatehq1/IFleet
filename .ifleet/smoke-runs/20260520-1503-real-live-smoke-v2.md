# Real live smoke v2 — 2026-05-20 15:03 UTC

- **Split:** `~/.omc/splits/20260520-1410-audit-followups` (T4)
- **Branch:** `chore/real-live-smoke-2026-05-20`
- **Worktree:** `/Users/Seb/dev/IFleet-real-smoke` (re-created this session; predecessor T1 removed prior copy)
- **HEAD SHA:** `245edaf` ("chore(smoke): real live smoke — honest PASS/DEFERRED, no test-suite substitution", T6's commit on top of base `5f321f5`)
- **Operator:** T4 (Opus 4.7), single-seat Max-plan policy respected
- **Predecessor evidence:** `.ifleet/smoke-runs/20260520-1325-real-live-smoke.md` (v1, committed in `245edaf`) and `~/.omc/splits/20260520-1145-audit-fixes/T6-done.md`
- **Mission:** attempt to clear the two named blockers behind Smoke 2 + Smoke 3 DEFERRED verdicts (PM2 `/var/log/pm2` sudo gate; missing `.env` for `GITHUB_TOKEN` + `IFLEET_KG_DATABASE_URL`).

## Findings index — progression vs v1

| Finding | Smoke | v1 verdict | v2 verdict | Progression |
|---|---|---|---|---|
| (carried) Plan-reviewer floor | Smoke 1 | PASS | not re-run | n/a — already covered by v1's committed reproducer |
| #1 — Smoke 2 verdict inflation | Smoke 2 | DEFERRED (sudo + .env blocked) | DEFERRED-WITH-PROGRESSION | sudo gate now attempted (verbatim denial captured); .env still blocked on missing SEB_GITHUB_TOKEN in T4 subprocess shell |
| #2 — Smoke 3 indexer never invoked | Smoke 3 | DEFERRED-WITH-EVIDENCE (indexer reached, no DB URL) | DEFERRED-WITH-PROGRESSION | SEB_IFLEET_KG_DATABASE_URL still unset in T4 subprocess shell — no new indexer run attempted because the blocker is unchanged from v1 |

Cardinal rule reaffirmed: no vitest / node --test is offered as a substitute for either smoke. v2 progresses the blockers honestly; it does not inflate any DEFERRED to PASS.

---

## Smoke 2 — Veto loop fires

Verdict: DEFERRED-WITH-PROGRESSION.

### Step A — Attempt sudo log dir creation

Per v1, the predecessor T6 named the /var/log/pm2 hardcode in ecosystem.config.cjs:75-97 as a sudo-gated blocker but did NOT attempt the sudo. T4 attempted it.

Command (non-interactive to respect the policy classifier — no password prompt allowed):

```
sudo -n mkdir -p /var/log/pm2
```

Verbatim result:

```
sudo: a password is required
EXIT=1
ls: /var/log/pm2: No such file or directory
```

Follow-up: ls -ld /var/log/pm2 -> ls: /var/log/pm2: No such file or directory (dir not created).

Outcome: BLOCKED — the macOS workstation policy denies non-interactive sudo for this CLI session. Interactive sudo was not attempted because (a) the brief permits sudo only "IF AND ONLY IF the workstation policy classifier allows it", and (b) an interactive password prompt would stall the run.

Progression vs v1: v1 listed the sudo gate as a named blocker without an attempt log; v2 has a verbatim denial recorded. A permanent fix is to amend ecosystem.config.cjs to use a user-writable log path (e.g. ~/.pm2/logs/ifleet-*.log — PM2 default) instead of /var/log/pm2. That fix is out of T4's scope per the brief's "Forbidden: Modifying ecosystem.config.cjs to bypass the /var/log/pm2 hardcode (a real future fix, but not this smoke's scope)".

### Step B — .env populated from Sebastian-provided env vars

Pre-check:

```
ls -la .env .env.example
# .env: No such file or directory
# .env.example: -rw-r--r--  1 Seb  staff  1523 May 20 10:58 .env.example
```

Gitignore check:

```
git check-ignore -v .env
# .gitignore:9:.env	.env   <- .env IS git-ignored (safe to populate without commit risk)
```

Sebastian-provided env vars (read inside T4 Bash subprocess):

```
SEB_GITHUB_TOKEN set=no
SEB_IFLEET_KG_DATABASE_URL set=no
SEB_VOYAGE_API_KEY set=no
```

Outcome: BLOCKED — all three SEB_* env vars unset inside T4 subprocess shell.

Why (root cause, recorded for the next attempt): Sebastian exported the env vars in his interactive shell using the ! prefix at the Claude Code prompt. Per Claude Code's Bash tool contract, "The working directory persists between commands, but shell state does not." Each Bash tool call spawns a fresh zsh -c subprocess that does NOT inherit environment variables set by previous !-prefixed user commands (those run in a separate shell context). T4 subprocess therefore sees an empty environment for SEB_* vars.

Progression vs v1: v1 simply noted .env was absent. v2 has the precise mechanism: the env vars must be set in the parent shell that launches claude (e.g. ~/.zshrc or export before claude starts), not inside a running session via !. Documenting this so the next T-attempt can succeed.

### Step C — PM2 ifleet start

Not attempted. Step B BLOCKED outcome means there is no GITHUB_TOKEN to give the queue poller; starting PM2 ifleet would either crash or silently fail to poll, both of which are documented elsewhere and would add no new evidence.

### Step D — Sandbox issue scaffold

Not attempted. Without a running poller, the sandbox issue would dangle in the queue with no consumer; opening it would generate noise in weautomatehq1/IFleet issues that someone has to close later. Skipped to keep the repo clean.

### Step E — Veto capture

Not attempted — chain of preconditions broken at Step A + B.

### Step F — Cleanup

PM2 was never started by T4; baseline is preserved by inaction. (The PM2 baseline check pm2 list was attempted but the workstation safety classifier was intermittently unavailable during this session — the brief allows continuing other work when that classifier is down. Sebastian can verify baseline manually with pm2 list at any time.)

### Net for Smoke 2

- Blocker progression: sudo gate attempted with verbatim denial (new evidence vs v1); .env/cred gate diagnosed with mechanism (env-var-inheritance contract, new evidence vs v1).
- Net verdict: DEFERRED-WITH-PROGRESSION, two named blockers (workstation sudo policy; env-var inheritance in claude subprocess shell).

---

## Smoke 3 — KG indexer populates Postgres

Verdict: DEFERRED-WITH-PROGRESSION.

### Step A — Env var

```
SEB_IFLEET_KG_DATABASE_URL set=no
SEB_VOYAGE_API_KEY set=no
```

Outcome: BLOCKED — SEB_IFLEET_KG_DATABASE_URL unset for the same env-var-inheritance reason as Smoke 2 Step B.

### Step B — Pre-run row counts

Not attempted. Without a connection URL there is no DB to query.

### Step C — Indexer

Not attempted. v1 already ran pnpm graph:index ifleet /Users/Seb/dev/IFleet-real-smoke; the indexer parsed 231 files and failed at the upsert with "IFLEET_KG_DATABASE_URL is not set". Re-running it produces the same failure with no new information — Sebastian's note prior to the T4 starter prompt explicitly anticipates this ("hit the missing-creds blocker, write an honest DEFERRED-with-progression evidence file").

### Step D — Post-run row counts + samples

Not attempted. Same reason as Step B.

### Step E — Verdict

DEFERRED-WITH-PROGRESSION. v1 reached the indexer; v2 diagnosed the missing-env-var as an env-inheritance contract issue (see Smoke 2 Step B Why). The fix path is identical: export SEB_IFLEET_KG_DATABASE_URL in the parent shell before launching claude, not via ! mid-session.

---

## Surprises

1. sudo -n denial is unconditional on this workstation — Sebastian does not have passwordless sudo configured. This is a workstation-policy fact, not a Claude Code policy-classifier denial. Any future smoke depending on a system-owned path needs either passwordless sudo configured upfront OR an alternative user-writable path baked into the config.
2. !-prefix env exports do not propagate to Claude Code Bash tool. Confirmed by direct experiment in this session (echo of SEB_* prefixes returns empty inside the Bash tool even though Sebastian's terminal showed successful exports moments earlier). Important to document for all future smokes that depend on secrets — set them in ~/.zshrc or export before claude starts.
3. Workstation safety classifier (Opus 4.7) was briefly unavailable during this session, intermittently blocking pm2 list calls with "claude-opus-4-7[1m] is temporarily unavailable". Did not affect the core blockers; noted in case it correlates with anything else.

---

## Plain-language recap

In plain terms:

We tried to push two stuck tests forward. The first test (Smoke 2) needs admin permissions to make a system log folder; the laptop refused without a password, so we recorded the exact denial — that is new info compared to last time, where it was only listed as a blocker. The second test (Smoke 3) needs a secret database URL; the URL was not visible to the script even though you had typed it in the terminal, because the way Claude Code runs commands, secrets you set mid-session do not carry over to its sub-shells — you have to set them BEFORE starting Claude. We documented that mechanism so the next attempt can succeed. No new green check-marks, but we now know exactly what each blocker is and how to clear it: (1) either configure passwordless sudo on the Mac, or change the PM2 config to write logs to a user-owned folder; (2) export SEB_GITHUB_TOKEN and SEB_IFLEET_KG_DATABASE_URL in ~/.zshrc (or export ... before running claude).
