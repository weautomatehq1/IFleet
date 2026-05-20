# Anti-fabrication audit — 2026-05-19

Sweep of `docs/elevation/**/*.md` and `.ifleet/**/*.md` for **claim-shaped tables**: markdown tables that purport to summarize numeric or boolean values from a checked-in data file. These are the surface area where doc/data drift can ship undetected, as happened in PR #128.

## Method

- Walked every `.md` under `docs/` and `.ifleet/`.
- Flagged any table whose cells assert specific values that originate (or should originate) from a checked-in JSON/JSONL artifact.
- Distinguished:
  - **Claim-shaped, retrospective:** table summarizes a *past* run captured in a data file → must be wrapped in `<!-- claim:* src="..." -->` so the new harness can verify it.
  - **Forward-looking targets:** table declares KPI baselines/targets (e.g., "M6 target: >80%"). Not a claim about current data; out of scope for the harness.
  - **Schema/interface tables:** describe SQL columns, CLI commands, event payloads. No data-file claim; out of scope.

## Findings

| # | File | Lines | Shape | Status |
|---|------|-------|-------|--------|
| 1 | `docs/elevation/upgrades/01-verifier.md` | 170–176 | claim-shaped (summary metrics) | **VIOLATION** — contradicts `.ifleet/eval/replay-results.json` |
| 2 | `docs/elevation/upgrades/01-verifier.md` | 180–191 | claim-shaped (per-task breakdown) | **VIOLATION** — every row in JSON has `status: "error"`; doc reports 9 `passed` / 1 `failed` |
| 3 | `docs/elevation/eval-set.md` | 70–77 | forward-looking target metrics (baseline=unknown, M6 target) | out of scope |
| 4 | `docs/elevation/upgrades/03-knowledge-graph.md` | 137–141 | embedding-model comparison (Voyage vs. OpenAI) | out of scope (vendor data, not a checked-in artifact) |
| 5 | Other `docs/elevation/upgrades/*.md` | various | schema, CLI commands, week-by-week plans, failure-mode lists | out of scope |
| 6 | `.ifleet/invariants/weautomatehq1_IFleet/README.md` | — | invariant rules description | out of scope |

**Tally:** 2 claim-shaped tables found, 2 violations, 0 correct (no claim block was in place before this PR).

## Violation detail — `docs/elevation/upgrades/01-verifier.md`

Both tables in the `### M1 DoD eval replay results — 2026-05-19 (real run)` section assert outcomes that the JSON they reference (`.ifleet/eval/replay-results.json`) directly contradicts.

JSON top-level on current `main`:

```json
{
  "passedCount": 0,
  "totalCount": 10,
  "passRatePct": 0,
  "disagreementRate": null,
  "dodGatePassed": false,
  "tasks": [ /* all 10 entries have "status": "error" */ ]
}
```

The doc currently asserts:

| Metric | Doc says | JSON says |
|---|---|---|
| Pass rate | 9 / 10 (90%) | 0 / 10 (0%) |
| DoD gate (≥ 8 / 10) | ✓ PASSED | ✗ FAILED |
| `disagreementRate` | 0.100 | `null` |
| Per-task statuses | 9× passed, 1× failed | 10× error |

## Relationship to PR #129

PR #129 (state: OPEN as of this writing) adds a *new* "PR #102 root cause" subsection explaining that the eval-replay harness failed during git clone in the historic run, so the JSON's all-error state reflects an infrastructure failure rather than a real disagreement. That explanation is correct. PR #129 does **not** replace or wrap the fabricated summary/per-task tables in claim blocks; once #129 lands, the descriptive text and the tables tell contradictory stories.

## Proposed corrections (do NOT apply in this PR — scope discipline)

This audit only flags. Corrective rewrites belong in a follow-up PR (or as an amendment to #129). Suggested shape for the summary block:

```markdown
<!-- claim:replay-results src=".ifleet/eval/replay-results.json" -->
| Metric | Value |
|---|---|
| Pass rate | 0 / 10 (0%) |
| DoD gate (≥ 8 / 10) | ✗ FAILED |
| disagreementRate | null |
| Avg duration per run | 2457 ms |
| Total cost | $0.00 |
<!-- /claim -->
```

The per-task breakdown table should either be regenerated from the JSON's `tasks[]` array (each row's `status: "error"` instead of fabricated "passed"/"failed") or removed entirely until a successful Docker-sandbox replay produces a real-data version. A follow-up PR should also add a `pr102-investigation` claim type if the team wants the harness to cover `.ifleet/eval/pr102-investigation.json` once it lands with PR #129.

To preview the corrected table for any block:

```sh
pnpm validate-claims --fix-suggestions
```

## Follow-up items (for T1 / future PRs)

1. **Fix the violation.** Rewrite the two tables in `01-verifier.md` to match `replay-results.json`, wrapped in `<!-- claim:replay-results -->` blocks. Do this either as an amendment to PR #129 or as a successor PR.
2. **Re-run the eval-replay against the Docker-sandboxed M1 DoD harness** so the JSON itself reflects a real pass run, then update the wrapped table from the new JSON.
3. **Adopt the claim block convention going forward.** Any future doc that summarizes numbers from a checked-in artifact must wrap the table in `<!-- claim:* src="..." -->`. The CI gate enforces this for tables that already use the convention; new wraps are still author discipline.
4. **Consider adding more claim types** as additional data-file-summarized tables get authored — e.g., `verifier-baseline`, `pr102-investigation`, future M2+ benchmark JSONs.
