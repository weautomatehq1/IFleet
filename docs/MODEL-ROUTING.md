> ⚠️ **Superseded** — the canonical routing policy is `~/.claude/skills/CANONICAL-PATTERN.md` Section 3 (correctness-first matrix). The Phase B Opus cap documented below was a cost-first guard from PR #41 and is now policy-superseded; code alignment (Phase C) ships in a future sprint. Until that ships, Phase B remains the live policy IFleet's classifier enforces. The manual pipeline (`~/.claude/skills/audit-fix/subagents/triager.md`) routes per the canonical matrix today.
>
> Supersedure protocol: see canonical-pattern Section 7. This note is removed when `src/classifier/index.ts` aligns to canonical.

---

# Model Routing — Phase B Reference

> This doc covers the routing policy shipped in PR #41. It is the authoritative
> reference for which model each pipeline role gets on any given issue.

## The three roles

- **Architect** — reads the brief and writes the plan. The most expensive seat; routing policy focuses on protecting this one.
- **Editor** — writes the code. Always one tier below architect; can be overridden by `routing.json` rules.
- **Reviewer** — second opinion on the diff. Runs at architect strength or higher so the review is never weaker than the work being reviewed.

---

## Default routing table

Tiers without any labels set (no `complexity:*`, no `priority:*`, no `chore`/`docs`):

| Scorer signal | Architect | Editor | Reviewer |
|---|---|---|---|
| No keywords (score 0) | haiku | haiku | haiku |
| Medium keywords only (score 1–2) | sonnet | haiku | sonnet |
| High keyword present (score ≥ 3) | sonnet *(capped from opus)* | haiku | sonnet |

**High keywords** (each scores +3): `auth`, `security`, `migration`, `rls`, `critical`, `oauth`, `encryption`, `payment`, `stripe`, `supabase`

**Medium keywords** (each scores +1): `refactor`, `feature`, `component`, `api`, `route`, `integration`, `hook`, `service`

The scorer alone can never push architect above sonnet. Only `complexity:high` unlocks opus for architect (see Phase B cap below).

---

## Label gates

| Label | Effect on architect | Effect on editor | Effect on reviewer |
|---|---|---|---|
| `complexity:high` | Forces **opus** regardless of score | one tier below architect → **sonnet** | Mirrors architect → **opus** |
| `complexity:low` | No direct effect; Phase B cap still applies (cannot reach opus) | follows architect | follows architect |
| `priority:high` | Bumps scored tier +1 (opus cap still applies) | follows architect tier | follows architect |
| `priority:low` | Parsed but no routing effect in current implementation | — | — |
| `chore` / `docs` / `chore:*` / `docs:*` | Bumps scored tier −1 (floor: haiku) | follows architect | follows architect |
| `model:opus/sonnet/haiku/codex` | Parsed but **not yet wired** into routing (reserved) | — | — |

### Phase B opus cap (the key constraint)

```
architectModel = opus   →   capped to sonnet
                 UNLESS complexity:high is set
```

This cap fires in two places in `src/classifier/index.ts`:
1. After scoring: `baseTier === 'opus' ? 'sonnet' : baseTier`
2. After routing.json rule application: `if (complexity !== 'high' && architectModel === TIERS.opus)`

No path other than `complexity:high` can produce an opus architect. Not scorer keywords, not `routing.json` rules, not `priority:high`.

### routing.json explicit overrides

`config/routing.json` rules are keyword/glob-based and apply **after** scoring but **before** the final Phase B cap. The cap always gets the last word on architect model.

Current rules that affect model selection:

| Match | Role overridden | Model set |
|---|---|---|
| `architect`, `design`, `security`, `auth`, `migration`, `rls`, `critical` | architect | opus (then capped to sonnet unless `complexity:high`) |
| `refactor`, `rename`, `boilerplate`, `test gen`, `stub`, `format` | editor | sonnet |
| `*.tsx`, `*.css`, `app/**`, `components/**` | editor | sonnet + playwright verify |
| `*.sql`, `migrations/**`, `supabase/**` | architect | opus (then capped to sonnet unless `complexity:high`) |

Editor overrides from `routing.json` are **not** subject to the Phase B cap — they can set editor to sonnet independently of the tier math.

---

## Worked examples

### 1 — Simple typo fix (no labels)

**Issue title:** "Fix typo in README header"
**Labels:** *(none)*

| Step | Value |
|---|---|
| Keyword score | 0 (no high or medium keywords) |
| Base tier | haiku |
| Label bumps | none |
| Architect | **haiku** |
| Editor | bumpTier(haiku, −1) = **haiku** |
| Reviewer | matches architect → **haiku** |

---

### 2 — Standard feature (no labels)

**Issue title:** "Refactor user profile component"
**Labels:** *(none)*

| Step | Value |
|---|---|
| Keyword score | `refactor` (+1) + `component` (+1) = 2 → sonnet |
| Base tier | sonnet |
| Phase B cap | sonnet ≠ opus, no cap |
| Architect | **sonnet** |
| routing.json | `refactor` matches editor-sonnet rule → editor = **sonnet** (explicit) |
| Reviewer | matches architect → **sonnet** |

---

### 3 — Heavy work explicitly marked

**Issue title:** "Replace OAuth provider and update session middleware"
**Labels:** `complexity:high`

| Step | Value |
|---|---|
| Keyword score | `oauth` (+3) = 3 → opus |
| Base tier | opus |
| complexity:high | overrides Phase B cap → architect = **opus** |
| Architect | **opus** |
| Editor | bumpTier(opus, −1) = **sonnet** |
| Reviewer | matches architect → **opus** |

---

### 4 — Heavy-looking text, operator wants cheap

**Issue title:** "Implement Stripe billing and update auth flow"
**Labels:** `complexity:low`

| Step | Value |
|---|---|
| Keyword score | `stripe` (+3) + `auth` (+3) = 6 → opus |
| Base tier | opus (capped immediately) |
| Architect (initial) | sonnet (Phase B: baseTier === opus → sonnet) |
| routing.json | `auth` rule tries to set architect = opus |
| Phase B final cap | complexity !== 'high' → resets architect to **sonnet** |
| Architect | **sonnet** |
| Editor | bumpTier(sonnet, −1) = **haiku** |
| Reviewer | matches architect → **sonnet** |

---

## Sprint modes (per-task routing)

Independent of the tier/score pipeline above, a task can carry a **mode** that
reshapes the architect's planning prompt and (optionally) overrides the
architect/editor model from `config/routing.json`. Modes mirror the operator
slash-commands the team uses on Discord.

| Mode | What it does | Architect override | Editor override | Verify extras |
|---|---|---|---|---|
| `standard` | Default architect plan, no special handling. | — | — | — |
| `ralph` | Persistence loop: plan a retry-friendly fix, enumerate fallback steps. | sonnet | sonnet | typecheck + lint + test |
| `ulw` | Ultrawork: parallel-safe multi-file edits, shared types first. | sonnet | sonnet | — |
| `tdd` | Failing tests first, then implementation. | sonnet | sonnet | typecheck + lint + test |
| `deslop` | Deletion-heavy clean-up of AI-generated boilerplate. | haiku | sonnet | — |

### How a mode is picked

Priority, highest → lowest:

1. `task.mode` field on the unified `QueuedTask` contract (operator-pinned, e.g.
   Discord slash-command `/ralph …`).
2. A `mode:<x>` label on the GitHub issue.
3. A `mode: <x>` header line at the top of the brief body.
4. A `/<mode> ...` prefix at the start of the brief body.
5. The **Haiku auto-router** (`src/classifier/auto-router.ts`) — only invoked
   from `classifyTaskAsync`, never from the sync `classifyTask` path.
6. **No mode** — RoutingDecision.mode stays `undefined`; architect uses the
   standard prompt.

### Auto-router behavior

- Reads brief + last 50 lines of `.omc/learnings.md` + risk flags from
  `docs/SECURITY.md` (optional file; keyword-only fallback when missing).
- Calls `claude --print --model claude-haiku-4-5-20251001` with a 5-second
  timeout and a 2000-char output cap (≈200 tokens).
- Caches by `sha256(title|body|labels)` for the process lifetime — sprint
  retries do not re-bill Haiku.
- **Kill switch:** `AUTO_ROUTER_DISABLED=1` short-circuits to the standard
  fallback without spawning the CLI.
- **Confidence floor:** below `0.6` the decision is dropped, the routing
  decision stays mode-less, and an optional `onLowConfidence` callback fires
  so the operator can be notified (see Discord posting in `daemon.ts`).

### Mode-tagging examples

- Label-driven: add `mode:ralph` to a GitHub issue.
- Body-header: first line of the brief is `mode: tdd`.
- Slash-prefix: paste `/deslop clean up the generated worker stub` into a
  Discord channel watched by the bot.

See `docs/briefs/_examples/` for one full example per mode.

---

## When to add `complexity:high`

Use it sparingly — it hits the 5-hour Claude Max rate limit and blocks all other fleet lanes until the session resets.

- **Security or auth rewrites** — OAuth flows, session token handling, RLS policies, encryption key rotation
- **Cross-system migrations** — database schema changes, multi-service refactors, anything that touches a production data path irreversibly
- **Multi-system orchestration logic** — changes that span three or more services, background workers, or external APIs where a silent failure cascades

If you're unsure, start without the label. Add it only if a first sonnet pass produces a shallow or incorrect plan.

---

## What is not yet wired

| Feature | Where it lives | Status |
|---|---|---|
| Codex Pro as editor | `pipeline.editor.switchable` in `config/routing.json` | Reserved field; provider swap not active |
| `model:*` label routing | Parsed in `src/queue/labels.ts` | Extracted into `hints.model` but `classifyTask` does not read it |
| `priority:low` tier bump-down | Parsed in `src/queue/labels.ts` | No routing effect; bump logic only handles `priority:high` |
| Per-sprint budget cap interaction | `src/orchestrator/` | Budget guard pauses the sprint but does not downgrade in-flight opus workers |

---

## References

- **PR #41** — `feat(classifier): complexity:high label gates architect opus` — the merge that shipped Phase B routing
- **Issue #43** — follow-up: review logic hardening (tracked separately, being closed by T2)
- **Issue #44** — follow-up: `complexity:low` explicit tests (tracked separately, being closed by T2)
- **`config/routing.json`** — live routing rules; edit here to add keyword/glob overrides
- **`src/classifier/index.ts`** — routing engine; this doc describes what the code actually does
- **`src/queue/labels.ts`** — label parsing; defines all recognized `key:value` label shapes
