# Impact of the Elevation Plan on Existing IFleet Code

> Answers the question: "Does this affect anything we plan on building within IFleet?" Short answer: yes, in seven specific ways, all aligned (no rewrites needed).

## TL;DR

The elevation plan **threads into** existing IFleet code, it does not replace it. Most of what's already shipped is the right substrate. Specific touchpoints below.

## 1. `src/verify/` — kept, repositioned

**Current role:** Runs `pnpm typecheck/lint/test` + Playwright inside the editor's worktree as part of the editor session. Owns `ci.ts`, `playwright.ts`, `runner.ts`, `screenshot.ts`, `config-loader.ts`, `spawn-util.ts`, `types.ts`.

**New role (M1):** Becomes the **pre-flight** layer. Runs fast, in-worktree, gives editor immediate feedback. The new `src/agents/verifier/` (Docker sandbox) becomes the **closed-loop gate** after editor completes. Both layers stay; they have different jobs.

**What changes:**
- No code changes in M0/M1 — `src/verify/` keeps doing what it does.
- M1.W1 adds `src/agents/verifier/` as a new sibling directory.
- M1.W2 wires `editor.completed` → `VerifierAgent` (existing `verify/` still runs inside editor session).
- M4: `verify/screenshot.ts` extends to write `fingerprint_before` / `fingerprint_after` JSON (additive, no removal).

**Affected files in M1:** `src/orchestrator/sprint.ts` (subscribe new event), `src/orchestrator/types.ts` (new event type), `src/orchestrator/store.ts` (new migration).

## 2. `src/pipeline/reviewer.ts` — renamed, kept

**Current role:** Cross-provider diff-reviewer. Editor writes diff → opposite provider (Codex if Claude wrote, Claude if Codex wrote) reads the diff in a fresh session, posts review.

**New role (M2):** Stays. Becomes one of TWO reviewers:
- `diff-reviewer.ts` (renamed from `reviewer.ts`) — current behavior, reviews after editor
- `plan-reviewer.ts` (new) — reviews the architect's plan **before** editor runs, can veto with structured `reasons[]`

**Why both:** They catch different bugs. Plan-reviewer catches "this plan won't work because X is structurally wrong." Diff-reviewer catches "the code as written has a subtle bug." MARS paper validates the two-reviewer pattern.

**Affected files in M2:** Rename `pipeline/reviewer.ts` → `pipeline/diff-reviewer.ts` (with re-export shim for one release). Add `pipeline/plan-reviewer.ts`. Update `pipeline/runner.ts` to insert plan-reviewer step between architect and editor.

**ARCHITECTURE.md needs updating** (currently says "Pipeline per task (3 roles)" — becomes 4 roles).

## 3. `src/pipeline/learnings.ts` — repositioned (derived, not edited)

**Current role:** Per-repo accumulated learnings from past sprints. Direct file editing pattern.

**New role (M1+, per ADR-0001):** Becomes a **derived artifact**. Trace events → nightly summarizer → `learnings.md`. No more direct writes from inside sprint execution.

**Why:** The single-trace invariant. If `learnings.md` is written outside the trace, the trace is no longer the source of truth, and shadow eval (M0.U8) can't replay reliably.

**Migration path:**
- M1.W1: Keep current behavior, add `learnings.md.derived` written from trace nightly. Compare for drift.
- M2: Cut over to derived-only. Add header banner `<!-- derived from trace; do not edit -->`.
- M3+: All updates flow via trace events of kind `learning.added`.

**Affected files:** `src/pipeline/learnings.ts` (gains derive-from-trace function), `scripts/derive-learnings.ts` (new), cron in `ecosystem.config.cjs`.

## 4. `src/pipeline/doctor-scan.ts` + `fingerprints.ts` + `rollup.ts` — substrate for M5/M6

**Current role:** Daily fingerprints and rollup. The "doctor scan" that already exists.

**New role:** This is the **input** to the Proposer (M5). The Proposer reads:
- doctor fingerprints (current state)
- rollup (recent trends)
- learnings.md (derived)
- SPRINT.md, ROADMAP.md, NON_GOALS.md (newly created in M0)
- Last 30 days of PR decisions (M4 — `pr_decisions` table)

**What changes:** Nothing in M1-M3. M5 adds `src/agents/proposer/` which reads these.

**The CoherenceWatcher (M6)** reuses the daily fingerprint cron and extends it to diff cross-repo links.

## 5. `src/orchestrator/approval-gate.ts` — extended for proposals

**Current role:** HITL approval gate for `/plan` workflow. User approves a paused plan with `/approve <taskid>`.

**New role (M5):** Same machinery, extended to handle **proposal approvals**. When Proposer emits `proposer.candidates`, they post to `#ifleet-proposals` with `[Approve] [Reject] [Defer]` buttons. The button handler reuses `approval-gate.ts`.

**Affected files:** Discord button registry (new candidate types), `approval-gate.ts` gains `kind: 'plan' | 'proposal'` discriminator.

## 6. `src/classifier/` — feeds economic routing in M6

**Current role:** Routes briefs to model tiers (Haiku classifier → architect/editor/reviewer model assignment).

**New role (M6):** Stays as the static fallback. After 100+ tasks per `(repo_id, task_kind)` cell, the Thompson sampling bandit in `src/agents/economic-router/` overrides the static routing. Below 100 samples per cell, classifier output is canonical.

**Why staged:** Bandits need data. Static classifier is correct at cold start.

**Affected files in M6:** Add `src/agents/economic-router/` (new). `pipeline/runner.ts` checks bandit availability, falls back to classifier output.

## 7. `pipeline/architect.ts`, `editor.ts`, `interview.ts` — gain trace-aware inputs

**Current role:** Take a brief + context, produce a plan / code / interview output.

**New role (M1+):** Same outputs, but inputs change to `(trace_so_far, role_specific_prompt)` per ADR-0001. Existing prompt logic preserved; just add a `trace` parameter that's stuffed into the system prompt as "What happened so far in this task."

**Affected files:** All three gain a new `trace` parameter. Backward-compatible (parameter optional with default to empty array during migration).

## 8. Discord layer (`src/discord/`) — new commands, no rewrites

| New command | Month | Replaces? |
|---|---|---|
| `/verify <taskId>` | M1 | No — augments `/status` |
| `/propose <repo>` | M5 | No — new |
| `/proposer-budget <repo> <n>` | M5 | No — new |
| `/graph stats` / `/graph search` / `/graph links` | M3 | No — new |
| Daily standup post (cron) | M1 | No — new |
| Weekly retro post (cron) | M5+ | No — new |
| `[Approve] [Reject] [Defer]` proposal buttons | M5 | Reuses approval-gate.ts |

## 9. GitHub queue layer (`src/queue/`) — unchanged

The "SprintManager emits events, never calls GitHub directly" architecture rule (mandatory per CLAUDE.md) **already enables** everything in this plan. No queue changes needed. New agents emit events the queue layer translates to GitHub API calls as today.

## Things the plan explicitly does NOT change

- HMAC signing between Discord bot and control plane
- SQLite for task state (Postgres is **separate** infra for the knowledge graph only)
- PM2 deployment on Hostinger VPS
- Single-seat Max-plan concurrency policy (5 lanes max)
- Cross-provider review policy (M2 keeps diff-reviewer)
- Branch protection on `main`
- Channel-to-repo mapping + per-channel `allowedUserIds`

## Things the plan adds infra-wise

| Component | When | Cost |
|---|---|---|
| Docker on Hostinger VPS | M1 | Free (already installed for n8n? verify) |
| Postgres + pgvector | M3 | Use Supabase (already in stack) — free tier sufficient |
| S3-compatible blob storage for trace exports | M1 | Hostinger Object Storage — ~$5/mo |
| Voyage AI or OpenAI embeddings | M3 | ~$5-20/mo at IFleet's volume |

## Conflicts with current ARCHITECTURE.md "Out of scope for v1"

The current ARCHITECTURE.md lists as out-of-scope:
- ✅ "Multi-persona debate agents" — **STAYS out of scope**. The Plan-Reviewer is single-trace structured pushback, not debate.
- ✅ "Three-tier autonomy frontmatter" — **STAYS out of scope**. Binary auto/review + HITL approval is sufficient.
- ✅ "Per-token cost tracking" — **STAYS out of scope**. Economic routing uses outcomes (merged/rejected), not tokens.
- ✅ "Client-facing sprint reporter" — **STAYS out of scope until Operating Standard signed off**.

No conflicts. The plan respects the existing out-of-scope list.

## Action items from this analysis

1. Update `docs/ARCHITECTURE.md` in M2 to reflect 4-role pipeline (was 3).
2. Rename `src/pipeline/reviewer.ts` → `diff-reviewer.ts` in M2 (with re-export for one release).
3. Add `learnings.md` derive script in M1, cut over in M2.
4. Verify Docker is installed on Hostinger VPS (M0.W1 prep for M1).
5. Decide Postgres location (Supabase preferred) — M0.W1 to remove M3.W1 blocker.
