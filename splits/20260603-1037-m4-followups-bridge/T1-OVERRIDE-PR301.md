# Strict-gate override record: PR #301 (T2 — M4.6+M4.8)

approver: weautomatehq1
timestamp: 2026-06-03T15:13:59Z  # PR #301 mergedAt

## Failed /codex-review verdicts (from T1-done.md:13-17)

**Round 1 FAIL** (T1-done.md:13):
> `"FAIL — categoryOverrideTriggered rule-path overreach (matched-rule's whole keyword list, not the keyword that actually hit)"`

**Round 2 FAIL** (T1-done.md:14):
> `"FAIL — false positive on complexity:high → baseTier=opus path; trace + run-of-tests refuted; verifier confirmed"`

## Counter-evidence (from T1-done.md:15-16, 79, 95)

From T1-done.md:15-16:
- `verifier_subagent_round1: "PASS — missed the rule-path overreach codex caught (lesson: cross-provider review earned its keep)"`
- `verifier_subagent_round2: "PASS — full-trace evidence, 396/0 node:test + 643/0 vitest"`

From T1-done.md:79:
> "Codex round-2 verdict was a demonstrable false positive. Verifier PASS independently confirmed the trace (full reviewer report cited line-by-line evidence including the exact `signal = "architect"` → `CATEGORY_NEEDLES.some(n => "architect".includes(n)) → false` reasoning). Sebastian authorised override via AskUserQuestion, citing the verifier evidence + the tests-green run."

From T1-done.md:95 (T3 final suite — confirms PR #301 introduced no regressions, full suite run post-T3 merge):
> "Codex PASS + verifier PASS, full suite 1062/0 (414 node:test + 648 vitest)."

**Precedent:** T2 round-1 codex FAIL was a *real* bug (rule-path overreach at `src/classifier/index.ts:264-273` inspected the matched rule's full `match.keywords` array rather than the specific keyword that hit). Verifier missed it; codex caught it. This established that cross-provider review earns its keep. Round-2 codex FAIL was traced and refuted: `applyLabelBumps` (index.ts:145-159) does not read `complexity:*`; `complexity:high` mutates `architectTier` at index.ts:213, AFTER the scorer-path trigger at index.ts:203 has read `baseTier`; Test 6 (`complexity:high + mode:tdd → sonnet/sonnet`) passes in the merged suite. The round-2 FAIL was a demonstrable false positive.

## Strict-mode chain exception path

**No exception path exists** in `MASTER.md` §"Per-PR review chain" (lines 63-70) or in `~/.claude/skills/splittasks/SKILL.md` §"Tiered review chain" (lines 234-253) for the case where:

- Codex returns FAIL on one or more review rounds
- Verifier returns PASS
- T1 traces the codex verdict as a demonstrable false positive with line-level evidence
- The approving human (weautomatehq1) authorises merge via AskUserQuestion citing the verifier evidence + green test run

The SKILL.md §"Tiered review chain" (lines 240-243) states "Both must PASS to merge" for AUDIT-fix PRs, and "PASS required to merge" for Feature PRs (codex-only). PR #301 was a Feature PR; T1 elected to spawn verifier for extra confidence on classifier load-bearing code (not mandated). Even with the elected dual review, no documented adjudication path exists for codex-FAIL + verifier-PASS + human override.

**Recommendation:** Add to `~/.claude/skills/splittasks/SKILL.md` §"Tiered review chain" an adjudication escape hatch:

> "If codex returns FAIL and verifier returns PASS (or vice versa), or if codex returns FAIL and the reviewer can demonstrate a false positive with line-level trace evidence: T1 may request human adjudication via AskUserQuestion. The authorising human must supply counter-evidence. T1 archives the override as `<SESSION_DIR>/T<N>-OVERRIDE-PR<#>.md` containing: `approver`, `timestamp` (PR mergedAt), exact failed verdict text, counter-evidence with cited line ranges, and this exception-path clause."
