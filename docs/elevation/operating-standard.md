# IFleet AI Operating Standard

> One-page liability document. Must be signed off before any client repo runs through IFleet. Defines what IFleet does and does not claim, what a human reviewer commits to when they hit Approve, and the rollback path.

## What IFleet is

An autonomous code-generation pipeline that opens **draft pull requests** against repositories. Final merge decisions are made by humans.

## What IFleet does NOT claim

- It does not claim the generated code is correct.
- It does not claim the verifier output covers every failure mode.
- It does not claim the architect's plan is the best plan.
- It does not claim the model behind any role (Opus, Sonnet, Haiku, Codex) is deterministic.
- It does not claim it is safe to merge without human review.

## What IFleet DOES guarantee (verifiable)

For every PR IFleet opens, the following artifacts exist and are exportable:

| Artifact | Storage | How to access |
|---|---|---|
| Full task trace (every role's input/output) | SQLite + S3 blob | `gh pr view <N> --json body` includes a `Trace:` link |
| Verifier run report (pass/fail, structured failures) | `verifier_runs` + `verifier_failures` tables | Posted as PR comment within minutes of PR creation (async — see note below) |
| Cost breakdown per role (USD spent) | Trace events with `cost_usd` field | `/status <taskId>` in Discord |
| Model versions used per role | Trace events with `model` field | Same |
| Source brief / issue that triggered the task | GitHub issue link | PR description, top line |

The trace, cost, model-version, and source-brief artifacts are written before the PR opens and are immutable at PR-open time.

**Verifier timing note:** The inline build + test gate (`pnpm run build` / `pnpm test`) runs synchronously and must pass before the PR is opened. The full Docker sandbox + invariant report (`verifier_runs` / `verifier_failures`) is generated asynchronously: the verifier pipeline subscribes to the `task.completed` event, which fires after PR creation, and attaches results as a PR comment within minutes. Human reviewers should wait for this comment before approving. Wiring the Docker verifier as a hard pre-merge gate is a planned future upgrade.

## Planned guarantees (post-M4)

The following artifact is **not** guaranteed today. It ships with Upgrade M4 (behavioural fingerprinting) and will move into the table above once that milestone lands. Listing it here makes the pre-M4 framing honest: a PR opened before M4 will not carry this artifact.

| Artifact | Storage (planned) | How to access (planned) | Lands with |
|---|---|---|---|
| Behavioral fingerprint diff (OpenAPI / schema / UI / trace shape) | JSON blob | Attached to PR description | M4 |

## What a human reviewer commits to when they hit Approve

By approving a PR with label `ifleet:autogen`, the human reviewer is asserting:

1. They have read the diff in its entirety.
2. They have read the verifier report and understand any `verified: partial` caveats.
3. They have read the behavioral fingerprint diff if `breaking: true` is labeled (M4+; pre-M4 this artifact is absent — see "Planned guarantees" above).
4. They take responsibility for the merge.

The reviewer is **not** asserting:
- That the code is bug-free (verifier may miss things)
- That no regression will occur (fingerprint comparison is best-effort)
- That IFleet will not propose the same broken pattern again (separate concern: PR rejection learning, M4)

## Rollback path

For any PR IFleet merges (after human approval):

1. **Within 1 hour:** `git revert <merge-sha>` in the affected repo, push to `main`. Standard git revert. No special tooling.
2. **Within 24 hours:** trigger `/cancel <taskId>` to flag the task in IFleet's learnings.md as `rolled_back: true` with reason.
3. **For IFleet self-PRs (Upgrade 10):** `pm2 reload ecosystem.config.cjs --update-env` against prior git tag. Documented in `deploy/rollback.sh` (v1 shipped — single-PR revert + optional PM2 reload + healthz verify + audit log; multi-host and time-windowed variants are planned follow-ups).

## Client repo specifics

Before IFleet touches a client repo:

1. Client signs off on this Operating Standard.
2. The client repo's `allowedUserIds` (per Discord channel) is limited to client + WeAutomateHQ staff.
3. The client repo has a dedicated channel mapping (no shared channels).
4. Branch protection on `main` enforces the existing rule: IFleet opens draft PRs only; human approval required to merge.
5. A copy of the trace export is delivered to the client per PR (S3 signed URL, 30-day expiry).

## Canary signal: when to stop trusting IFleet

IFleet's **verifier↔reviewer disagreement rate** is the SLO. If the 7-day moving average exceeds 25%:

1. Auto-alert in `#ifleet-ops` Discord channel.
2. Manual review: spot-check the 5 most recent disagreements.
3. If verifier is systematically missing a failure class, file an issue, add invariant rule, re-baseline.
4. If disagreement >40% for 7 days, **pause client repo work** until root cause is fixed.

## Data handling

- **No client code in IFleet's learnings.md.** Per-client learnings live in the client's own repo at `.ifleet/learnings.md`.
- **No client secrets in traces.** Sanitization happens at trace-write time, validated nightly.
- **Trace exports:** delivered to clients via signed URL with 30-day expiry. Not stored in IFleet's S3 long-term.

## Out of scope for this standard

- Compliance with specific frameworks (SOC2, HIPAA, GDPR) — addressed per-client when applicable.
- Generative AI disclosure language for end-user-facing products — client's responsibility.
- Insurance / E&O coverage — separate business decision.

## Version

v0.1 (2026-05-19) — initial draft, internal use only. Update before first client engagement.

## Sign-off

> **Status as of 2026-06-04: not ready for client use.** Upgrade 10 (self-improvement) prerequisites are partially unmet — see `docs/elevation/upgrades/10-self-improvement.md` for detail. Sign-off is deferred until all Upgrade 10 gates clear and implementation is validated.
>
> **Blocking items:**
> - eval-set: 13/50 rows required (Upgrade 10 gate) — in progress
> - `src/agents/self-improver/` not yet built — planned M4+
> - Legal review not yet initiated

- [ ] Sebastian Puig (founder, WeAutomateHQ) — pending Upgrade 10 readiness and legal review
- [ ] (legal review, before first client signature)
