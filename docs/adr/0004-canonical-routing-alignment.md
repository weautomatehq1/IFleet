---
Status: Accepted
Date: 2026-06-03
Decider: Sebastian Puig
Supersedes: PR #41 (Phase B Opus cap rationale — not a prior ADR, see context)
Superseded-by: None
Affects: src/classifier/index.ts, src/classifier/__tests__/classifier.test.ts, docs/MODEL-ROUTING.md, docs/ARCHITECTURE.md, docs/CANONICAL-PIPELINE.md
Extends: ~/.claude/skills/CANONICAL-PATTERN.md §3 (canonical correctness-first routing matrix)
---

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

1. **5-account Claude Max pool shipped.** The fleet now runs across ~15 concurrent lanes (5 accounts × ~3) with round-robin and rate-limit-aware queueing. One account hitting its 5-hour window no longer stalls the fleet — other accounts continue.
2. **Strict-mode cross-provider review gate shipped (M2 + the 2026-05-20 audit-cleanup pattern).** Every audit-fix PR now runs `/codex-review` AND a `verifier` subagent in parallel, both required to PASS before merge. The review gate catches the regressions that a downshifted-tier architect would produce, so the cheaper tiers are safer than they were when Phase B was authored.

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

The supersedure note on `docs/MODEL-ROUTING.md` is removed; the body is rewritten to describe the canonical matrix as the live policy. Related doc updates land in the same commit (ARCHITECTURE.md "policy intent vs live behaviour" hedge removed, CLAUDE.md Phase B caveat removed, ROADMAP.md M4.5 marked shipped, CANONICAL-PIPELINE.md "Route to model" ⚠️ → ✅, `~/.claude/skills/CANONICAL-PATTERN.md` Footnotes entry added).

## Rationale

**Correctness > cost when both are in tension.** The Phase B framing was rational when the fleet ran on one Max account and the review gate was less mature. With the 5-account pool absorbing rate-limit risk and the cross-provider review gate catching regressions, the cost-savings from routing security/auth/payments findings through Sonnet no longer outweighs the mistake-cost when Sonnet gets one wrong. Canonical §3 makes this trade explicit: "mistake cost > model cost" for the top three matrix rows.

**The cap was creating a documentation lie.** Every IFleet doc that described routing had to qualify it with "Phase B cap holds." Operators reading the codebase saw Opus in routing.json rules and assumed it would be honored. The cap silently demoted those rules. Removing the cap aligns code behavior with what every routing doc already describes as the intent.

**The safety net assumption is enforced.** Canonical §3.5 makes the dependency explicit: the routing matrix assumes the strict-mode review gate is enforced. As long as `/codex-review` + Claude `verifier` parallel review continues to fire on every audit-fix PR, the cheaper tiers stay safe. If that gate is ever disabled, canonical §3.5 specifies the entire matrix downshifts one tier — Haiku→Sonnet, Sonnet→Opus — which automatically re-tightens cost.

**Operator manual overrides preserved.** `complexity:high` continues to force Opus regardless of scorer signal. `complexity:low` continues to be parsed (for future use) but no longer demotes a category-override Opus. Operators can still pin a model via the `mode:*` label routing wiring (M5 deferred) when that lands.

## Consequences

**Cost impact (estimated):** more Opus runs for security/auth/payments/migration findings. Pre-Phase C, these routed through Sonnet by default unless `complexity:high` was labeled. Post-Phase C, they default to Opus. Best estimate based on closure-log labels: ~25-35% of audit findings touch a HIGH_KEYWORDS surface (auth, security, migration, SQL, RLS, payments, encryption, Supabase). Those will now consume Opus tokens against the Claude Max plan rather than Sonnet. Flat-rate plan, so no $$ delta — the delta is rate-limit-window consumption.

**Rate-limit risk mitigation:**
- 5-account pool (~15 concurrent lanes) means one Opus-heavy sprint no longer stalls the fleet.
- The OMC rate-limit-wait wrapper (per IFleet stack) round-robins across accounts when one hits its window.
- If Opus-window consumption becomes a bottleneck despite the pool, the canonical §3.6 cost-tuning signal applies: monitor the closure log for Haiku-fixed PRs sent back for revision. If revision rate stays below ~1 in 5, the matrix is correctly tuned. Above that, narrow the bottom two matrix rows (canonical §3.6).

**Doc supersedure trail:**
- `docs/MODEL-ROUTING.md` rewritten in this PR; old supersedure header removed. The doc now describes the canonical matrix as the live policy with a one-line pointer to this ADR for history.
- `~/.claude/skills/CANONICAL-PATTERN.md` Footnotes section gets the "§3 routing aligned with `IFleet/src/classifier/index.ts` in PR #<NNN> on 2026-06-03" entry per canonical §7 step 4.
- `docs/CANONICAL-PIPELINE.md` "Route to model" status flips from ⚠️ (partial / tracked supersedure) to ✅.
- ROADMAP.md M4.5 row marked shipped with the merge PR number.

**Tracked future work:** The `audit-to-ifleet.sh` bridge script (canonical §5.3) is still future work; this ADR does not address it. Once the bridge ships, audit findings flowing from manual `/audit-scan` into the IFleet queue will hit this new routing policy automatically.

**Rollback path:** Revert this PR and the cap blocks come back exactly as they were in `1bf88a4`. No data migration; the change is code-side only.

## Alternatives considered

1. **Keep the Phase B cap, override only on `complexity:high` label.** Rejected because it pushes the routing decision onto the operator's label hygiene rather than letting the scorer make a correctness-first call. The scorer already detects auth/security/payments/migration — making the operator re-confirm with `complexity:high` is busy-work and a source of false negatives.

2. **Move the routing decision into config/routing.json entirely (no scorer at all).** Rejected because the scorer handles freeform issue titles where labels are absent or wrong. The rules engine is a complement, not a replacement.

3. **Add a `category:*` label scheme and gate Opus on `category:security|auth|payments|migration`.** Considered as a future enhancement. Today the HIGH_KEYWORDS scorer + routing.json rules cover the same surface; adding labels is a separate UX consideration that doesn't block Phase C.

4. **Defer Phase C until M5 ships and observe Phase B behaviour with full instrumentation first.** Rejected because the supersedure note has been on MODEL-ROUTING.md / CANONICAL-PIPELINE.md / ARCHITECTURE.md since 2026-06-02; every day the cap stays is a day the docs describe one policy and the code enforces another. The realignment session explicitly tracked this as the next sprint's work.
