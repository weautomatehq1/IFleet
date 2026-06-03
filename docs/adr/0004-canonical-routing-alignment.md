---
Status: Accepted
Date: 2026-06-03
Decider: Sebastian Puig
Supersedes: None
Superseded-by: None
Affects: src/classifier/index.ts, src/classifier/__tests__/classifier.test.ts, docs/MODEL-ROUTING.md, docs/ARCHITECTURE.md, docs/CANONICAL-PIPELINE.md
Extends: ~/.claude/skills/CANONICAL-PATTERN.md §3 (canonical correctness-first routing matrix)
---

> **Free-text supersedure note:** retires the Phase B Opus cap rationale originally shipped in PR #41. PR #41 was not a prior ADR; this ADR captures the policy retirement explicitly. (Frontmatter `Supersedes: None` because the schema in `docs/adr/README.md` only allows `None | ADR-NNNN`; the PR-level supersedure is recorded here in prose.)

# ADR-0004 — Canonical routing alignment (Phase C migration)

**Status:** Accepted (2026-06-03)
**Decider:** Sebastian Puig
**Supersedes:** PR #41 Phase B Opus cap rationale
**Affects:** IFleet classifier and all model-routing decisions

## Context

PR #41 (the "Phase B" model-routing policy) shipped a cost-first guard that capped the Architect role at Sonnet unless the operator explicitly labeled the issue `complexity:high`. The cap fired in two places in `src/classifier/index.ts`:

1. After the scorer derived a tier, `baseTier === 'opus' ? 'sonnet' : baseTier` demoted any scorer-driven Opus back to Sonnet.
2. After the routing.json rule pass, `if (complexity !== 'high' && architectModel === TIERS.opus) architectModel = TIERS.sonnet` demoted any rule-driven Opus back to Sonnet.

The motivation at the time: a single Claude Max account had a 5-hour rate limit; an Opus architect could burn the window on a single sprint and stall the fleet silently. Routing was tuned cost-first to keep the fleet running.

Two things changed since PR #41:

1. **Multi-account Claude Max pool architecture is in place; one additional seat is configured but disabled today.** `config/workers.json` defines a worker pool with `claude-max-1` enabled and `claude-max-2` defined with `enabled: false` pending profile setup. The pool code lives at `src/workers/account-pool.ts` (+ tests at `src/workers/__tests__/account-pool.test.ts`) and round-robins enabled workers via `nextWorker()`; rate-limit reactions are observed via `markRateLimited(...)` in test scenarios but the runtime wiring from worker `rate_limit` events to that pool method is not yet end-to-end (today rate-limit hits are counted in `src/pipeline/factory.ts` but the pool's `markRateLimited` is not invoked from the live pipeline). Long-term target: 5 Claude Max seats × ~3 concurrent = ~15 lanes (per `docs/ARCHITECTURE.md` Constraints section); today's reality is 1 enabled seat with ~3 concurrent and headroom to enable more as authentication profiles get configured. Rate-limit risk under Opus-heavy windows therefore remains real — the cap was load-bearing for that risk in single-seat operation. This ADR accepts that residual risk because (a) the OMC wait/resume wrapper still pauses the fleet cleanly when a window hits rather than failing sprints, (b) enabling the second seat is a config flip (no code change), and (c) the rate-limit mitigation is the lesser of the two correctness/cost concerns the canonical matrix balances — see canonical §3.6 cost-tuning signal for the rebalance trigger if Opus consumption becomes a bottleneck. Wiring `markRateLimited` end-to-end from the worker rate_limit event into the pool is tracked as an observability follow-up; until then the OMC wrapper is the actual present pause mechanism.
2. **Strict-mode cross-provider review gate shipped (M2 + the 2026-05-20 audit-cleanup pattern).** Every audit-fix PR now runs `/codex-review` AND a `verifier` subagent in parallel, both required to PASS before merge. The review gate catches the regressions that a downshifted-tier architect would produce, so the cheaper tiers are safer than they were when Phase B was authored. This is the primary safety net under the new policy.

In parallel, the 2026-06-02 canonical-pattern realignment session (PR #299) authored `~/.claude/skills/CANONICAL-PATTERN.md` as the single source of truth across the manual `/splittasks → /audit-*` pipeline and the autonomous IFleet fleet. Canonical §3 specifies a correctness-first routing matrix:

| Pattern | Model |
|---|---|
| `CRITICAL` × any category | Opus |
| Any × `security` / `auth` / `payments` / `migration` | Opus |
| `IMPORTANT` × `correctness` (logic, multi-file) | Sonnet |
| `IMPORTANT` × `maintainability` touching call sites | Sonnet |
| `IMPORTANT` × procedural config | Sonnet |
| `COSMETIC` × style / lint / whitespace / import-sort | Haiku |
| Truly atomic single-line | Haiku |
| Ambiguous shape | Sonnet (round up) |

Override precedence (highest wins):
1. Category ∈ {security, auth, payments, migration} → Opus regardless of severity.
2. CRITICAL severity → Opus regardless of category.
3. Otherwise the matrix row that matches.

This canonical policy is in direct conflict with the Phase B cap on point #1 / #2 (canonical forces Opus where Phase B forced Sonnet). The realignment session documented the conflict via the supersedure protocol in canonical §7: every IFleet doc that previously described Phase B routing was flagged with a header note pointing at canonical as the spec, and the code alignment was tracked as a separate work item — **M4.5 Phase C migration** — to ship in a follow-up PR.

This ADR is that follow-up. It records the decision to align IFleet's classifier to the canonical correctness-first matrix and retires the Phase B rationale.

## Decision

**Remove the Phase B Opus cap.** Specifically:

1. Delete both cap sites in `src/classifier/index.ts`. The architect tier derivation now uses `let architectTier: Tier = baseTier` (no demotion). The post-rule cap block is deleted.
2. Update `src/classifier/__tests__/classifier.test.ts` to assert canonical-aligned behavior:
   - HIGH_KEYWORDS hits (auth, security, migration, payments, critical, oauth, encryption, stripe, supabase, rls) route the architect to Opus.
   - `complexity:high` continues to force Opus (manual operator override for cases the scorer underestimates).
   - `complexity:low` is parsed but **does NOT** demote a category-override Opus — canonical §3.2 override #1 wins "regardless of severity."
3. Retain the Plan-Reviewer "Opus architect → Sonnet plan-reviewer" floor. Canonical §2.5 specifies "Haiku or Sonnet" for the Plan-Reviewer (it's a cheap pre-gate, not a full diff review), so the existing floor matches canonical intent. The inline comment is updated to cite canonical §2.5 rather than the Phase B rate-limit rationale.
4. Editor remains Sonnet-floor (canonical §2.4 + IFleet mandatory rule 3 from CLAUDE.md). No change.
5. `config/routing.json` requires no change — its rules already assign Opus to security/migration/SQL globs; the cap that prevented them from taking effect was code-side only.

The supersedure note on `docs/MODEL-ROUTING.md` is removed; the body is rewritten to describe the canonical matrix as the live policy on the scorer + routing.json rule paths. Related doc updates land in the same commit (ARCHITECTURE.md "policy intent vs live behaviour" hedge removed and scoped to scorer/rule paths, CLAUDE.md Phase B caveat removed and scoped, ROADMAP.md M4.5 marked shipped, CANONICAL-PIPELINE.md "Route to model" reframed as scoped ⚠️ ship with M4.6/M4.7/M4.8 follow-ups tracked, `~/.claude/skills/CANONICAL-PATTERN.md` Footnotes entry added).

## Rationale

**Correctness > cost when both are in tension.** The Phase B framing was rational when the review gate was less mature. With the cross-provider review gate catching regressions before merge, the cost-savings from routing security/auth/payments findings through Sonnet no longer outweighs the mistake-cost when Sonnet gets one wrong. Canonical §3 makes this trade explicit: "mistake cost > model cost" for the top three matrix rows. Rate-limit risk under single-seat operation remains real (see §Context bullet 1); we accept that residual risk because the review gate is the primary correctness mitigation and the OMC wait/resume wrapper keeps the fleet alive through Opus-window exhaustion rather than failing sprints.

**The cap was creating a documentation lie.** Every IFleet doc that described routing had to qualify it with "Phase B cap holds." Operators reading the codebase saw Opus in routing.json rules and assumed it would be honored. The cap silently demoted those rules. Removing the cap aligns code behavior with what every routing doc already describes as the intent.

**The safety net assumption is enforced.** Canonical §3.5 makes the dependency explicit: the routing matrix assumes the strict-mode review gate is enforced. As long as `/codex-review` + Claude `verifier` parallel review continues to fire on every audit-fix PR, the cheaper tiers stay safe. If that gate is ever disabled, canonical §3.5 specifies the entire matrix downshifts one tier — Haiku→Sonnet, Sonnet→Opus — which automatically re-tightens cost.

**Operator manual overrides preserved.** `complexity:high` continues to force Opus regardless of scorer signal. `complexity:low` continues to be parsed (for future use) but no longer demotes a category-override Opus. The `mode:*` label routing wiring is already live (per `config/routing.json` modes block) — modes can still pin architect/editor models, with the known interaction described in "Known limitations" below.

## Consequences

**Cost impact (estimated):** more Opus runs for security/auth/payments/migration findings. Pre-Phase C, these routed through Sonnet by default unless `complexity:high` was labeled. Post-Phase C, they default to Opus. Best estimate based on closure-log labels: ~25-35% of audit findings touch a HIGH_KEYWORDS surface (auth, security, migration, SQL, RLS, payments, encryption, Supabase). Those will now consume Opus tokens against the Claude Max plan rather than Sonnet. Flat-rate plan, so no $$ delta — the delta is rate-limit-window consumption.

**Rate-limit risk mitigation:**
- Pool architecture supports multi-account rotation via `src/workers/account-pool.ts`; today's enabled count is 1 (`claude-max-1` in `config/workers.json`) with one additional seat (`claude-max-2`) defined but disabled pending profile setup. Long-term target per ARCHITECTURE.md Constraints is 5 seats × ~3 concurrent = ~15 lanes.
- The OMC rate-limit-wait wrapper pauses sprints cleanly when a window hits rather than failing them — sprints resume when the window resets. In single-seat operation this still pauses the fleet during the wait, but doesn't lose work.
- If Opus-window consumption becomes a bottleneck before additional seats are enabled, the canonical §3.6 cost-tuning signal applies: monitor the closure log for Haiku-fixed PRs sent back for revision. If revision rate stays below ~1 in 5, the matrix is correctly tuned. Above that, narrow the bottom two matrix rows (canonical §3.6); operationally that buys headroom by shifting Haiku-eligible work back to Sonnet, which is a cost-side rebalance that doesn't require a code change to the cap itself.

**Doc supersedure trail:**
- `docs/MODEL-ROUTING.md` rewritten in this PR; old supersedure header removed. The doc now describes the canonical matrix as the live policy with a one-line pointer to this ADR for history.
- `~/.claude/skills/CANONICAL-PATTERN.md` Footnotes section gets the "§3 routing aligned with `IFleet/src/classifier/index.ts` on 2026-06-03 (ADR-0004)" entry per canonical §7 step 4. The merge PR number is recorded in `git log --follow` on this ADR file rather than baked into the prose.
- `docs/CANONICAL-PIPELINE.md` "Route to model" status flips from ⚠️ (partial / tracked supersedure) to ✅.
- ROADMAP.md M4.5 row marked shipped with the merge PR number.

**Tracked future work:** The `audit-to-ifleet.sh` bridge script (canonical §5.3) is still future work; this ADR does not address it. Once the bridge ships, audit findings flowing from manual `/audit-scan` into the IFleet queue will hit this new routing policy automatically.

**Rollback path:** Revert this PR and the cap blocks come back exactly as they were in `1bf88a4`. No data migration; the change is code-side only.

## Known limitations + tracked follow-ups

Phase C ships the headline goal — remove the Opus cap, align the HIGH_KEYWORDS scorer + routing.json rule paths to canonical §3.2 override #1. It does **not** yet implement canonical §3.2 end-to-end. These gaps are documented so anyone reading the ADR knows what Phase C is and isn't:

1. **Mode overrides can downshift category-driven Opus assignments.** `config/routing.json` defines per-mode architect/editor pins (e.g. `mode:tdd` pins architect to Sonnet; `mode:deslop` pins architect to Haiku). After this ADR ships, an `auth`-titled task with `mode:tdd` will still produce architect=Sonnet, not Opus. Canonical §3.2 says category override #1 wins "regardless of severity" but the mode override applies AFTER the rule + cap pipeline at `src/classifier/index.ts:281-287`. The fix is to make category-driven Opus assignments sticky against mode demotion (e.g., a `categoryOverrideTriggered` flag the mode override block consults). Tracked as **M4.6 follow-up — mode override category protection**.

2. **Category and severity labels are not yet parsed.** `src/queue/labels.ts` recognises `complexity:*`, `priority:*`, `chore`/`docs`, `mode:*`, `model:*`, but does not parse `category:*` or `severity:*`. Canonical §3.2 overrides #1 and #2 are explicitly category/severity based. Today, those overrides are reachable only via the HIGH_KEYWORDS scorer (title/body keyword hits) — an operator who labels an issue `category:security` without putting "security" or "auth" in the title gets no Opus promotion. Tracked as **M4.7 follow-up — explicit category/severity label parsing + scorer-equivalence test set**.

3. **Reviewer parity breaks under mode overrides (preexisting bug).** Reviewer derivation runs at `src/classifier/index.ts:265-267` BEFORE the mode-override block at `:281-287`. If a mode override changes `architectModel` (e.g., `fix typo` + `mode:ralph` → architect Sonnet), the reviewer derived from the pre-override Haiku stays Haiku — violating the "reviewer not weaker than architect" invariant. This bug predates Phase C and is not introduced by this ADR, but the doc supersedure trail is the right place to surface it. Tracked as **M4.8 follow-up — reviewer derivation after mode overrides**.

4. **HIGH_KEYWORDS substring matching has known false-positive surface.** `scoreKeywords` uses `text.includes(kw)` so `author` matches `auth`, `noncritical` matches `critical`. Pre-Phase C the cap masked this — every false positive was demoted to Sonnet. Post-Phase C those false positives reach Opus. Canonical §3.6 cost-tuning signal applies: if closure log reports false-positive Opus runs (operator-flagged "didn't need Opus") above ~1 in 5 of HIGH_KEYWORDS-routed tasks, tighten the keyword list or move to word-boundary matching. Tracked as **observability follow-up — closure log cost-tuning telemetry**.

The combined effect of items 1–3 is that an operator who pins `mode:tdd` on an auth-themed task still gets the pre-Phase-C behaviour. That's a real correctness gap relative to canonical, but it's scoped down explicitly here so the next session has a clear plate of follow-up work rather than a hidden invariant violation. The supersedure note on canonical §7.4 footnote (added 2026-06-03) records "first worked-example supersedure resolved end-to-end" with the understanding that "end-to-end" means the scorer + rule paths; the mode + label paths are tracked above.

## Alternatives considered

1. **Keep the Phase B cap, override only on `complexity:high` label.** Rejected because it pushes the routing decision onto the operator's label hygiene rather than letting the scorer make a correctness-first call. The scorer already detects auth/security/payments/migration — making the operator re-confirm with `complexity:high` is busy-work and a source of false negatives.

2. **Move the routing decision into config/routing.json entirely (no scorer at all).** Rejected because the scorer handles freeform issue titles where labels are absent or wrong. The rules engine is a complement, not a replacement.

3. **Add a `category:*` label scheme and gate Opus on `category:security|auth|payments|migration`.** Considered as a future enhancement. Today the HIGH_KEYWORDS scorer + routing.json rules cover the same surface; adding labels is a separate UX consideration that doesn't block Phase C.

4. **Defer Phase C until M5 ships and observe Phase B behaviour with full instrumentation first.** Rejected because the supersedure note has been on MODEL-ROUTING.md / CANONICAL-PIPELINE.md / ARCHITECTURE.md since 2026-06-02; every day the cap stays is a day the docs describe one policy and the code enforces another. The realignment session explicitly tracked this as the next sprint's work.
