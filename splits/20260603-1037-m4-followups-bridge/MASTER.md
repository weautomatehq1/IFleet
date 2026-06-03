# MASTER — M4 followups + audit-to-ifleet bridge

> **Session:** `20260603-1037-m4-followups-bridge`
> **Mode:** strict gated · codex+verifier per PR · Opus T1
> **Origin:** ADR-0004 §Known-Limitations + canonical §5.3 — picks up the four follow-ups left after PR #300 (M4.5 Phase C scoped ship merged 2026-06-03).

## Goal

Close the three classifier follow-ups documented in `docs/adr/0004-canonical-routing-alignment.md` §Known-Limitations (M4.6/M4.7/M4.8) and ship the long-pending `audit-to-ifleet.sh` bridge script (canonical §5.3) so audit findings can flow from `/audit-scan` into IFleet's queue.

Each follow-up has a self-contained PR; T1 reviews and merges in dependency order.

**Mid-session scope expansion (approver: weautomatehq1, mid-session at Sebastian's prompt):** T5 (wire `rate_limit` events into `AccountPool.markRateLimited()` — ADR-0004 §Context bullet 1 live-wiring gap) and T6 (fix `AUDIT-IFleet-c9d0e1f2` — onForcePr push failure abort) were added after initial session start. Lane map, file-ownership, and review-chain sections updated in-session to reflect the expanded scope. Final PR set: T2 (#301), T3 (#304), T5 (#302), T6 (#303).

## Lane map

| Lane | Role | Model | Start | Owns |
|---|---|---|---|---|
| T1 | Orchestrator + per-PR reviewer | Opus | ◆ reviews done-reports as they land | (no edits) |
| T2 | M4.6 + M4.8 combined — mode-override category protection + reviewer derivation after mode (MERGE GATE) | Opus | ▶ start immediately | `src/classifier/index.ts`, `src/classifier/__tests__/classifier.test.ts` |
| T3 | M4.7 — explicit `category:*`/`severity:*` label parsing (downstream of T2) | Opus | ⏸ polls for T2-MERGED | `src/queue/labels.ts`, `src/queue/__tests__/labels.test.ts` (+ classifier integration), `src/classifier/index.ts`, `src/classifier/__tests__/classifier.test.ts` |
| T4 | `audit-to-ifleet.sh` bridge script | Sonnet | ▶ start immediately | `~/.claude/scripts/audit-to-ifleet.sh` (NEW) + `~/.claude/scripts/test-fixtures/audit-to-ifleet/` (NEW), `~/.claude/CLAUDE.md` (one-line entry in audit-pipeline section) |
| T5 | Wire `rate_limit` events into `account-pool.markRateLimited()` (ADR-0004 §Context bullet 1 live-wiring gap) | Opus | ▶ start immediately | `src/pipeline/factory.ts`, `src/workers/account-pool.ts`, `src/pipeline/__tests__/factory.test.ts` (new/extended), `src/workers/__tests__/account-pool.test.ts` (maybe) |
| T6 | Audit fix `AUDIT-IFleet-c9d0e1f2` — `onForcePr` push failure proceeds to PR creation | Opus | ▶ start immediately | `src/orchestrator/daemon.ts` (lines ~270-373 onForcePr region) + matching daemon test file |

## Why T2 is a merge gate

T2 and T3 both edit `src/classifier/index.ts`. T2 changes the mode-override block (currently lines ~281-289) and moves the reviewer-derivation block (currently lines ~265-267) to after the mode override. T3 needs to add a new override-precedence check (for `category:*`/`severity:*` labels) and wire it into classifyTask. Both touch the same function (`classifyTask`) but in different regions:

- T2 region: lines ~265-289 (reviewer derivation + mode-override block + their interaction)
- T3 region: lines ~197-218 (architect-tier derivation step) + labels.ts (entirely T3-owned)

To avoid rebase churn and reviewer cognitive load, T2 lands first. T3 waits via STEP 0 cat of the post-merge classifier file (see T3.md for the directive). T3 rebases its branch on the post-T2-merge main.

## Why T4 is independent

`audit-to-ifleet.sh` lives in `~/.claude/scripts/`, not the IFleet repo. T4 cannot touch any IFleet file under `src/` or `docs/`. No conflict possible with T2 or T3.

## Why T5 and T6 are independent

- **T5** owns `src/pipeline/factory.ts` rate_limit handler region + `src/workers/account-pool.ts`. T2/T3 own `src/classifier/`. T4 lives outside the repo. T6 owns `src/orchestrator/daemon.ts`. Zero file overlap with any other lane.
- **T6** owns `src/orchestrator/daemon.ts` `onForcePr` (lines ~270-373) — completely separate file from any other lane. T6's PR is **AUDIT-tagged** (`AUDIT-IFleet-c9d0e1f2` in title + `[audit-fix:AUDIT-IFleet-c9d0e1f2]` in body), which means T1's strict-mode review chain fires BOTH `/codex-review` AND `verifier` subagent in parallel for it (per `~/.claude/skills/splittasks/SKILL.md` tiered chain rule — feature PRs would only get codex-review, but AUDIT-* PRs get both).

All five workers (T2, T3, T4, T5, T6) can run in parallel from the start, with T3 the only one that waits on a gate (T2-MERGED via STEP 0).

## Gate signals

- `<SESSION_DIR>/T2-MERGED` (empty file): T2's PR merged into main. T3 polls for this via STEP 0 before pushing its own branch.
- Each worker also writes `T<N>-done.md` alongside their work, regardless of merge state.

`<SESSION_DIR>` = `/Users/Seb/dev/IFleet/splits/20260603-1037-m4-followups-bridge`

## Open audit findings (visible to all lanes)

Three open findings in `.audits/index.json` (last_updated 2026-06-02). None CRITICAL, none have `file_globs` set (so the cap-coordination rule doesn't apply):

- `AUDIT-IFleet-e664f9f3` (COSMETIC) — Nonce ledger per-process memory loses replay protection on restart
- `AUDIT-IFleet-c9d0e1f2` (IMPORTANT) — Git push failures in onForcePr proceed unconditionally to PR creation
- `AUDIT-IFleet-g3h4i5j6` (IMPORTANT) — unifiedToSprintId lookup intent non-obvious without annotation

None of these overlap classifier, labels, or audit-bridge work. Lanes proceed without coordination.

## Per-PR review chain (strict mode)

Per the canonical pattern §2.5 strict-mode review gate, every PR in this session goes through steps 1–3 and 5–6 below. Step 4 is **tiered by PR type** (corrected from original "every PR gets both" — that conflicted with T5's actual codex-only treatment; tiered chain is the source of truth):

1. `gh pr view <#>` — confirm title + body
2. CI checks all SUCCESS, mergeStateStatus CLEAN, commit-author = `weautomatehq1@gmail.com`
3. `/codex-review --pr <#>` (cross-provider) — PASS required for all PRs
4. **Verifier subagent — tiered by PR type:**
   - **T1–T4 (audit-fix PRs and behavioural feature PRs):** spawn `verifier` subagent in parallel with the PR diff — both PASS required to merge. (T1 elected verifier on T2 and T3 feature PRs for extra confidence on classifier load-bearing code; mandatory for AUDIT-fix PRs per canonical §2.5.)
   - **T5 (rate-limit wiring PR):** codex-only — verifier not spawned. Wiring is small + well-tested pipeline plumbing; one provider is sufficient for this scope.
   - **T6 and any future AUDIT-tagged PR:** codex-review + verifier both MANDATORY per canonical §2.5 strict-mode tiered chain; both PASS required to merge.
5. T1 merges via `gh pr merge <#> --squash --delete-branch --admin`
6. T1 `touch <SESSION_DIR>/T2-MERGED` if T2's PR (signals T3)

If either required reviewer FAILs: T1 leaves a PR comment with verdict + evidence and does NOT merge. Worker lane retries.

## File ownership — DO NOT EDIT OUTSIDE YOUR LANE

- T2: `src/classifier/index.ts` (lines ~265-289 specifically), `src/classifier/__tests__/classifier.test.ts` (new tests for mode-override category protection + reviewer-after-mode invariants)
- T3: `src/queue/labels.ts`, `src/queue/__tests__/labels.test.ts`, `src/classifier/index.ts` (architect-tier-derivation step ONLY, lines ~197-218), `src/classifier/__tests__/classifier.test.ts` (new tests for category:*/severity:* override paths). T3 also edits `docs/MODEL-ROUTING.md` label-gates table to add the new recognised labels.
- T4: `~/.claude/scripts/audit-to-ifleet.sh` (NEW), `~/.claude/scripts/test-fixtures/audit-to-ifleet/` (NEW dir with sample findings + expected gh issue payloads), `~/.claude/CLAUDE.md` (add ONE line to the audit-pipeline scripts list pointing at audit-to-ifleet.sh)
- T5: `src/pipeline/factory.ts` (rate_limit event handler region; threads pool into the spawn-time worker context if not already wired), `src/workers/account-pool.ts` (signature tweaks only if absolutely needed), `src/pipeline/__tests__/factory.test.ts` (new or extended), `src/workers/__tests__/account-pool.test.ts` (maybe), `docs/adr/0004-canonical-routing-alignment.md` (§Context bullet 1 resolution prefix)
- T6: `src/orchestrator/daemon.ts` (`onForcePr` region only, lines ~270-373), `src/orchestrator/__tests__/daemon.test.ts` (or wherever the daemon tests live — find via `find src/orchestrator -name '*.test.ts'`). T6 does NOT edit `.audits/index.json` — closure is owned by `/audit-complete` post-merge.
- T1: NO IFleet edits. T1 only reads, reviews, merges, and writes T1-done.md.

## Commit + push discipline

- Each worker on its own branch off `main`. Suggested names: `feat/m4.6-m4.8-mode-override-reviewer` (T2), `feat/m4.7-category-severity-labels` (T3), `feat/rate-limit-event-pool-wiring` (T5), `fix/audit-IFleet-c9d0e1f2-onForcePr-push-failure` (T6). T4 has no branch (script lives in ~/.claude/scripts/).
- Commit messages: standard repo style (lowercase verb, scope, concise subject). Add `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (or Sonnet for T4) per Sebastian's commit norm
- NO pushes to remote on a CLI from any worker other than `git push -u origin <branch>` for the worker's own branch. NO `git push origin main`. NO `--force`. NO `--no-verify`. NO `git add -A`
- Each worker stages specific files by name before commit

## Definition of done (T1's checklist)

1. T2-done.md present; T2's PR merged on `main`; `<SESSION_DIR>/T2-MERGED` touched
2. T3-done.md present; T3's PR merged on `main`; T3 verified T2-MERGED before pushing (`upstream_gate_observed_at` in T3-done.md postdates T2-MERGED mtime)
3. T4-done.md present; T4's script exists at `~/.claude/scripts/audit-to-ifleet.sh` and is exec-bit set; `~/.claude/CLAUDE.md` lists it; T4-done.md cites a successful dry-run against a fixture finding
4. T5-done.md present; T5's PR merged on `main`; ADR-0004 §Context bullet 1 carries the live-wiring resolution prefix
5. T6-done.md present; T6's PR merged on `main` with `AUDIT-IFleet-c9d0e1f2` in title and `[audit-fix:AUDIT-IFleet-c9d0e1f2]` in body; `/audit-complete` can close the finding from the merged PR
6. Every PR passed `/codex-review` before merge (PASS required). Verifier subagent is tiered: T2 and T3 (classifier-touching feature PRs, T1-elected) required both — both PASS; T5 (rate-limit wiring, feature PR, small scope) required codex-only — PASS; T6 (AUDIT-tagged) required both mandatory per canonical §2.5 — both PASS. See §"Per-PR review chain" above for the authoritative tiered chain.
7. T1-done.md present with PRs merged + SHAs + timestamps + any deferred items + plain-English recap

## Stop conditions (anything that should pause the lane)

- **T2 PR review FAILs** (codex-review OR verifier returns FAIL): T2 reads PR comments, fixes, re-pushes, requests re-review. Does NOT merge unilaterally.
- **T3 STEP 0 cat shows T2's changes did NOT land** (expected post-merge comment markers absent): T3 writes `T3-NEEDS-UPSTREAM.md` describing the gap and exits without pushing. T1 investigates.
- **T4 script fails its own dry-run against the fixture**: T4 fixes, re-runs, only writes T4-done.md when dry-run is green.
- **Audit-finding revision** (any of the 3 open findings above gets a new fix landing on `main` mid-session): T1 notes it in T1-done.md but no lane should be affected since none overlap our file globs.

## After all lanes merge

Optional follow-ups for the NEXT session (NOT in scope here):

- Enable `claude-max-2` in `config/workers.json` once the second profile is configured
- Promote the splittasks gate-enforcement rule from `~/.claude/skills/splittasks/SKILL.md` into a proper `~/.claude/rules/` entry once it's been exercised across 2-3 more sessions

These are documented in ADR-0004 / canonical-pattern Footnotes; T1 references but does not pursue them in this session.
