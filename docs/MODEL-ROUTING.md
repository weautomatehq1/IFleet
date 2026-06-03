# Model Routing — Reference (post-M4.5 canonical alignment)

> Implementation of the canonical correctness-first routing matrix from `~/.claude/skills/CANONICAL-PATTERN.md` §3.
> Policy decisions live in [ADR-0004](adr/0004-canonical-routing-alignment.md); this doc describes the runtime behaviour of `src/classifier/index.ts` against that policy.
> History: the Phase B Opus cap (PR #41) was the previous policy; it is retired by ADR-0004 (PR #<NNN>, 2026-06-03). The cap rationale and worked examples below have been rewritten to reflect the live canonical-aligned classifier.

## The three roles

- **Architect** — reads the brief and writes the plan. The most expensive seat; routing policy focuses on protecting this one.
- **Editor** — writes the code. Always one tier below architect; can be overridden by `routing.json` rules.
- **Reviewer** — second opinion on the diff. Runs at architect strength or higher so the review is never weaker than the work being reviewed.

---

## Default routing table

Tiers without any labels set (no `complexity:*`, no `priority:*`, no `chore`/`docs`):

| Scorer signal | Architect | Editor | Reviewer |
|---|---|---|---|
| No keywords (score 0) | haiku | sonnet *(editor floor)* | haiku |
| Medium keywords only (score 1–2) | sonnet | sonnet | sonnet |
| High keyword present (score ≥ 3) | opus | sonnet | opus |

**High keywords** (each scores +3): `auth`, `security`, `migration`, `rls`, `critical`, `oauth`, `encryption`, `payment`, `stripe`, `supabase`

**Medium keywords** (each scores +1): `refactor`, `feature`, `component`, `api`, `route`, `integration`, `hook`, `service`

Per canonical §3.2 override #1 (category ∈ {security, auth, payments, migration} → Opus regardless of severity), any high-keyword hit promotes the architect to Opus directly — no `complexity:high` label is required. The editor stays at the Sonnet floor (canonical §2.4 / IFleet mandatory rule 3). The reviewer mirrors the architect tier (canonical "reviewer not weaker than architect").

---

## Label gates

| Label | Effect on architect | Effect on editor | Effect on reviewer |
|---|---|---|---|
| `complexity:high` | Forces **opus** regardless of score (manual operator override for cases the scorer underestimates) | one tier below architect → **sonnet** | Mirrors architect → **opus** |
| `complexity:low` | Parsed but no demoting effect on a category override — canonical §3.2 override #1 wins "regardless of severity" | follows architect | follows architect |
| `priority:high` | Bumps scored tier +1 (can promote to opus when scored tier is sonnet) | follows architect tier | follows architect |
| `priority:low` | Parsed but no routing effect in current implementation | — | — |
| `chore` / `docs` / `chore:*` / `docs:*` | Bumps scored tier −1 (floor: haiku) | follows architect (editor floor at sonnet still applies) | follows architect |
| `model:opus/sonnet/haiku/codex` | Parsed but **not yet wired** into routing (reserved) | — | — |

### Override precedence (canonical §3.2)

Highest wins:

1. Any `category` keyword in {`security`, `auth`, `payments`, `migration`} → **Opus** regardless of severity. (Detected today via the HIGH_KEYWORDS scorer; future enhancement: explicit `category:*` labels.)
2. `CRITICAL` severity → **Opus** regardless of category. (Detected today via the `critical` HIGH_KEYWORD or `complexity:high` label.)
3. Otherwise the matrix row that matches.

### routing.json explicit overrides

`config/routing.json` rules are keyword/glob-based and apply **after** scoring. Rule-driven Opus assignments are honored unconditionally (no cap).

Current rules that affect model selection:

| Match | Role overridden | Model set |
|---|---|---|
| `architect`, `design`, `security`, `auth`, `migration`, `rls`, `critical` | architect | opus |
| `refactor`, `rename`, `boilerplate`, `test gen`, `stub`, `format` | editor | sonnet |
| `*.tsx`, `*.css`, `app/**`, `components/**` | editor | sonnet + playwright verify |
| `*.sql`, `migrations/**`, `supabase/**` | architect | opus |

Editor overrides from `routing.json` are independent of the architect tier math — they can pin the editor model regardless of the architect's score.

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
| Architect | **sonnet** |
| routing.json | `refactor` matches editor-sonnet rule → editor = **sonnet** (explicit) |
| Reviewer | matches architect → **sonnet** |

---

### 3 — Heavy work, scorer recognises it

**Issue title:** "Replace OAuth provider and update session middleware"
**Labels:** *(none)*

| Step | Value |
|---|---|
| Keyword score | `oauth` (+3) = 3 → opus |
| Base tier | opus |
| Override #1 | `auth` / `oauth` category → architect = **opus** (canonical §3.2) |
| Architect | **opus** |
| Editor | sonnet (editor floor) |
| Reviewer | matches architect → **opus** |

The `complexity:high` label is not needed here — the scorer already recognised this as a security/auth finding and the canonical override #1 routed it to Opus. Use `complexity:high` only when the scorer underestimates (no HIGH_KEYWORDS in the title but operator knows it's load-bearing).

---

### 4 — Heavy-looking text, operator hint says "go cheap"

**Issue title:** "Implement Stripe billing and update auth flow"
**Labels:** `complexity:low`

| Step | Value |
|---|---|
| Keyword score | `stripe` (+3) + `auth` (+3) = 6 → opus |
| Base tier | opus |
| Override #1 | `auth` / `payments` category → architect = **opus** (canonical §3.2 wins regardless of severity) |
| `complexity:low` | parsed but cannot demote the override |
| Architect | **opus** |
| Editor | sonnet (editor floor) |
| Reviewer | matches architect → **opus** |

`complexity:low` cannot override a category-driven Opus assignment. The override-precedence rule (canonical §3.2) is explicit: category override #1 wins "regardless of severity." If the operator genuinely needs to downshift this finding — e.g. the title says `stripe` but the actual work is cosmetic CSS in a Stripe-themed file — split it into two findings with more accurate titles.

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

`complexity:high` is now a **manual operator override** for cases the scorer underestimates. The HIGH_KEYWORDS scorer already promotes typical security/auth/payments/migration findings to Opus via canonical §3.2 override #1; you only need the label when the title doesn't surface a HIGH_KEYWORD but the work is still load-bearing.

Examples where `complexity:high` is still useful:

- **Architectural changes with bland titles** — "refactor the orchestrator state machine" scores `refactor` (+1) → sonnet, but the work might be load-bearing enough to want Opus.
- **Cross-system orchestration without HIGH_KEYWORDS** — changes spanning three or more services where the title doesn't mention auth/security/payments/migration.
- **Multi-file logic refactors hitting subtle invariants** — title says "rename helper" but the rename touches reviewer-gate logic.

Pre-M4.5 guidance said to use the label sparingly because of single-account rate-limit risk. That risk is now mitigated by the 5-account Claude Max pool — one Opus-heavy sprint no longer stalls the fleet. The strict-mode review gate (`/codex-review` + Claude `verifier` in parallel) catches regressions before merge, making the cheaper tiers safe and the Opus tier worth the marginal token cost for genuinely architectural work.

If you're unsure, start without the label. Add it only if the first pass produces a shallow or incorrect plan and the title doesn't already trigger a HIGH_KEYWORD.

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

- **[ADR-0004](adr/0004-canonical-routing-alignment.md)** — canonical routing alignment (Phase C migration); supersedes the Phase B Opus cap rationale
- **`~/.claude/skills/CANONICAL-PATTERN.md`** §3 — the canonical correctness-first routing matrix this doc implements
- **PR #41** — original Phase B cap (retired by ADR-0004); kept here for history
- **Issue #43 / Issue #44** — closed by the Phase B test hardening pass; tests now pin canonical-aligned behaviour
- **`config/routing.json`** — live routing rules; edit here to add keyword/glob overrides
- **`src/classifier/index.ts`** — routing engine; this doc describes what the code actually does
- **`src/queue/labels.ts`** — label parsing; defines all recognized `key:value` label shapes
