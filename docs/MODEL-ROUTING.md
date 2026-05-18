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
