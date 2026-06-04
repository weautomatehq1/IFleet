# MASTER — 20260603-1245-m4-foundation-plus-obs

## Goal

Push IFleet forward in parallel: lay the M4 fingerprinting foundation, close the last open audit cosmetic, and stage the P1 Observability (Langfuse-on-VPS) ADR + skeleton so Sebastian can green-light P1 without further planning.

Sprint context: M4 has 6 open tasks (see `SPRINT.md`). Locked plan (`docs/implementation_plan_2026_05_21.md`) puts P1 Observability as the next-phase gate after P2 audit integration.

## Mode

**Strict-mode gated.** Opus T1 + 4 Opus workers. Per-PR review is `/codex-review <PR#>` AND the `verifier` subagent in parallel (because every shipped PR in this session is either an audit-fix or a foundation change). Both must PASS to merge.

## Lane map

| Lane | Model | Role | Start | Branch |
|---|---|---|---|---|
| **T1** | Opus | Orchestrator + gated reviewer | ◆ reviews done-reports as they land | (no branch — review only) |
| **T2** | Opus | M4-T1/T2 — `pr_decisions.fingerprint` + fingerprint compute (**MERGE GATE for T3**) | ▶ start immediately | `feat/m4-fingerprint-foundation` |
| **T3** | Opus | M4-T5 — `RecordPrDecision` event in SprintManager | ⏸ polls for `T2-MERGED` | `feat/m4-record-pr-decision` |
| **T4** | Opus | Close `AUDIT-IFleet-e664f9f3` — nonce-ledger restart window | ▶ start immediately | `fix/audit-nonce-ledger-restart` |
| **T5** | Opus | P1 Observability prep — Langfuse-on-VPS ADR + docker-compose skeleton | ▶ start immediately | `docs/p1-langfuse-vps-adr` |

## Gate map

- **T2 is a MERGE gate.** T2 ships its PR; T1 runs the dual review chain; on PASS+merge T1 writes `splits/20260603-1245-m4-foundation-plus-obs/T2-MERGED`. T3 polls for that marker before pushing — but T3's **STEP 0** still cats T2's done-report file directly (the marker alone is not trusted).
- T4 and T5 are independent — no gate, no upstream.
- T1 reviews each `T*-done.md` as it lands; merges per the tiered review chain.

## Open audit findings (visible to all lanes)

From `.audits/index.json` (last_updated 2026-05-31):

- `AUDIT-IFleet-e664f9f3` — COSMETIC — Nonce ledger per-process memory loses replay protection on restart — `src/queue/control-plane.ts` — **T4 owns this**.

No other open findings. All previous IFleet audit waves are closed.

## Boundaries — global

- **T2 owns** `src/queue/store.ts` (pr_decisions schema), `src/agents/verifier/fingerprint.ts` (new), `src/agents/verifier/__tests__/fingerprint.test.ts` (new), and may touch `src/agents/verifier/store-bridge.ts` to expose typed insert helpers.
- **T3 owns** `src/orchestrator/sprint.ts` and `src/orchestrator/__tests__/daemon-pr-decision.test.ts` (extend existing). T3 reads but does NOT modify T2's files.
- **T4 owns** `src/queue/control-plane.ts` and any new persistence file under `src/queue/nonce-store-*.ts`, plus `SECURITY.md` (add restart-window section). T4 must NOT touch the pr_decisions schema or sprint.ts.
- **T5 owns** `docs/adr/0004-langfuse-on-vps.md` (new), `deploy/langfuse/docker-compose.yml` (new), `deploy/langfuse/README.md` (new), plus a one-paragraph section appended to `docs/implementation_plan_2026_05_21.md` (P1 status). T5 must NOT touch any `src/` file.

## Hold rules

- T3 must NOT push before `T2-MERGED` exists in this session dir. T3's PR depends on T2's schema being on main so the prisma-less `better-sqlite3` initialization can write the `fingerprint` column.
- No `--no-verify`. No `--force` push. No `git add -A`. Branch-protection self-approval workaround per strict-mode rule 8 (`gh pr merge --squash --delete-branch --admin` with explicit rationale comment).

## Per-PR review chain (T1)

Every PR shipped in this session matches `AUDIT-*` (T4) OR is a foundation change to SQLite schema / orchestrator behaviour (T2, T3). So **all** PRs get the dual review chain:

1. `gh pr view <PR#> --json title,body,headRefName,mergeStateStatus`
2. Spawn `/codex-review <PR#>` (subprocess, async)
3. Spawn `verifier` subagent (Task tool, async) with PR diff + relevant context (finding JSON for T4; sprint M4-T<N> rationale + SPRINT.md excerpt for T2/T3)
4. Wait for BOTH. Both must return PASS.
5. T5 is docs-only — `/codex-review` only, no verifier subagent (no behaviour to verify).

If either FAIL: comment the verdict on the PR, do NOT merge, ping the worker lane via their done-report's "notes for T1" mechanism (T1 writes a follow-up section in T1-done.md noting the FAIL).

## Verification discipline (before every merge)

- `mergeStateStatus` = `CLEAN` (re-poll on `UNKNOWN`)
- All required CI checks = `SUCCESS`
- Commit author = `weautomatehq1@gmail.com` (never `test@test`)
- Smell-test diff for `console.log`, `TODO`, `FIXME`, `.only(`, commented-out blocks
- For T2: cross-check the fingerprint test output by reading the test file with `cat`, do not trust the worker's hand-typed assertion table
- For T4 behavioural fix: run `pnpm vitest run src/queue/__tests__/control-plane.test.ts` locally and confirm the new persistence/restart test passes

## Polling cadence

T1 polls `splits/20260603-1245-m4-foundation-plus-obs/` every 60s for new `T<N>-done.md` files. On each new done-report:
1. Read the report end-to-end
2. Run the per-PR review chain above
3. On PASS+merge, append a one-line entry to MASTER.md's "Merge log" section below
4. If T2 merged, immediately `touch T2-MERGED` so T3 unblocks

## Merge log

(T1 appends here as PRs land — format: `YYYY-MM-DDTHH:MMZ · T<N> · PR #<num> · <sha> · <verdict>`)

- 2026-06-04T02:25Z · T2 · PR #312 · de20f6e · PASS (codex re-run with schema context, verifier PASS, smell-clean)
- 2026-06-04T02:29Z · T4 · PR #314 · 12cbf5c · PASS — closes AUDIT-IFleet-e664f9f3 (codex re-run with single-process deployment context, verifier PASS all 8 criteria, smell-clean)
- 2026-06-04T02:33Z · T5 · PR #313 · - · FAIL — stale base (branched from pre-M4 0b666ee, never rebased). GitHub reports CLEAN but actual diff against current main would WIPE T2's fingerprint impl/tests and revert T4's nonce_ledger schema. Recovery action documented in PR comment; PR left open for rebase + force-push.
- 2026-06-04T02:31Z · T3 · -      · - · ABORTED-UPSTREAM — T3 polled at 02:13Z, saw no T2-done.md (T2 finished at 02:19Z), wrote T3-NEEDS-UPSTREAM.md per its STEP 0 contract, never created a branch or PR. Marker file renamed to T3-NEEDS-UPSTREAM.md.aborted-2026-06-04T0213Z by a session hook. Re-launched at 02:30Z via RELAUNCH-T3.sh.
- 2026-06-04T02:48Z · T3 · PR #315 · d4c9903 · PASS (relaunch) — codex re-run with scope clarification on production teardown timing (out-of-scope for call-site wiring; tracked as M4-T6 follow-up), verifier PASS all criteria, smell-clean. Worker correctly relocated wiring from sprint.ts to daemon.ts:wireSprintCompletion per the SprintManager event-only invariant.

## Stop conditions

- All four workers report done. T1 finishes review chain, writes T1-done.md.
- Any FAIL that the worker lane has retried 2× without success → T1-done.md captures the open state and Sebastian sees it.
- Any worker times out (no done-report after 90 min of continuous work) → T1-done.md records "lane T<N> timed out, no merge".

## Audit-store preflight (lesson learned)

Finding `AUDIT-IFleet-318475be` exposed a divergence between the global audit store (`~/.claude/audits/IFleet/index.json`) and the repo-local store (`<repo>/.audits/index.json`). This MASTER.md cited `.audits/index.json last_updated 2026-05-31` with `AUDIT-IFleet-e664f9f3` open, while the global store had already closed it as deliberate on 2026-06-03T21:55:56Z. T4 then shipped a real fix against a finding the global view considered already-closed.

**Required prevention rule:** Before launching a strict-mode session, MASTER.md MUST cite both global (`~/.claude/audits/<project>/index.json`) AND repo-local (`<repo>/.audits/index.json`) audit-store state. If the two diverge on any open finding, LAUNCH.sh must abort and surface the divergence before proceeding. This prevents workers from fixing findings already closed in the global store (or worse, closing findings that only appear to be open due to a stale local cache).

## Session ID

`20260603-1245-m4-foundation-plus-obs`

## Absolute paths used in handoffs

- Session dir: `/Users/Seb/dev/ai-products/IFleet/splits/20260603-1245-m4-foundation-plus-obs/`
- Repo root: `/Users/Seb/dev/ai-products/IFleet/`
- T2 done report: `/Users/Seb/dev/ai-products/IFleet/splits/20260603-1245-m4-foundation-plus-obs/T2-done.md`
- T2 merge marker: `/Users/Seb/dev/ai-products/IFleet/splits/20260603-1245-m4-foundation-plus-obs/T2-MERGED`
