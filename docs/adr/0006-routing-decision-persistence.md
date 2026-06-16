---
Status: Accepted
Date: 2026-06-16
Decider: Sebastian Puig
Supersedes: None
Superseded-by: None
Affects: src/queue/store.ts, src/pipeline/factory.ts, src/agents/bandit/**, state/tasks.db schema
Extends: ADR-0001 (single-trace architecture), PR #354 (Thompson sampler shadow mode)
---

# ADR-0006 — Persist `routing_decision` on `tasks`, not on `pr_decisions`

**Status:** Accepted (2026-06-16, shipped in PR #362)
**Decider:** Sebastian Puig
**Supersedes:** None
**Extends:** PR #354 (M6-T2 Thompson sampler shadow substrate — accepted with the wiring decision deferred to this ADR)

## Context

PR #354 shipped the M6-T2 Thompson sampler + `routing_shadow_log` table and `recordShadowDecision`, but left the call-site wiring out of scope. The audit finding `AUDIT-IFleet-17c995db` flagged the substrate as "declared-but-dead" and was closed manually as "tracked for M6 closure."

Closing the gap surfaced a real spec hole in PR #354. `recordShadowDecision`'s docstring says the caller "typically reads observations from `pr_decisions`: `verdict='merged' → reward=1, verdict='rejected' → reward=0`." But the `pr_decisions` schema (`src/queue/store.ts:38-52`) has no model column. The `tasks` schema has no per-task model either — `routing_hints` is a freeform hint, not the actual decision. The live `RoutingDecision` (architect/editor/reviewer) was constructed at `src/pipeline/factory.ts:252` and discarded after task spawn.

Without persisting which model arm handled each task, the Thompson observations stream is empty forever. Beta posteriors stay uniform. Shadow picks are pure random. Worthless as a learning signal.

This ADR decides where the per-task routing record lives.

## Options considered

### Option 1 — `routing_decision TEXT` (JSON) column on `tasks`

Single new nullable column on the existing `tasks` row. Written by `TaskStore.setRoutingDecision(taskId, decision)` at the moment routing is decided (factory.ts:252). The observations reader does `pr_decisions p JOIN tasks t ON p.task_id = t.id` and uses `json_extract(t.routing_decision, '$.<role>.model')` to recover the arm.

**Pros**:
- One source of truth. Co-located with the existing routing context (`routing_hints`, `state`, `state_meta`).
- Survives multi-PR tasks. A retry/amend/follow-up PR for the same task naturally shares the same routing without duplicated state.
- Forward-compatible. Adding "temperature", "budget cap", "max-turns" later is a JSON field edit, not three new SQL columns.
- **Crash-safe at the decision point**. Routing is persisted in the same transaction window as task spawn — *before* the worker runs, *before* a PR exists. An orchestrator restart between routing-decided and pr-decision-written does NOT lose the assignment.

**Cons**:
- Every observation query is a `JOIN` (`pr_decisions × tasks`). Microseconds at this row scale.
- JSON in SQLite is opaque to indexing. "All tasks where architect=opus" would need `json_extract` or a derived index. Not a current requirement.

### Option 2 — `architect_model` / `editor_model` / `reviewer_model` columns on `pr_decisions`

Three new TEXT columns directly on `pr_decisions`. Written when the PR decision is recorded.

**Pros**:
- Single-table read for the observation stream — `SELECT architect_model, verdict FROM pr_decisions WHERE repo=?`.
- Each column is independently indexable.

**Cons**:
- **Crash-unsafe at the decision point.** The model decision is made when the task starts; the `pr_decisions` row is written hours or days later when the PR closes. An orchestrator crash in between loses the assignment forever — that task can never contribute to Thompson learning.
- Denormalized. A task spawning multiple PRs (retry storm) writes the same model triple per PR row.
- Schema-rigid. A 4th role or per-role metadata means another column.

### Option 3 — Defer M6 wiring entirely

Ship only the Voyager prompt rewrite (which has no schema dependency) and revisit M6 in a separate session. Buys time but the live bandit KPI gate (25% cost-per-task win) cannot start accumulating signal until the wiring lands.

## Decision

**Option 1: `routing_decision TEXT` column on `tasks`.**

The crash-safety argument is load-bearing. For a system whose entire job is to *learn from outcomes*, losing observations because of an orchestrator restart is a real correctness bug, not a rare-case ergonomic gap. Option 2 fails this property silently — the data loss is invisible until you notice the Thompson posteriors aren't converging.

The future-proofing argument is concrete, not hypothetical. `RoutingDecision` already carries `architect/editor/reviewer` — three nested objects, not three flat strings. Persisting the whole shape as JSON means adding `temperature`, `budget_cap_usd`, or `max_turns` later is a one-line type edit. Option 2 would require three new columns each time.

The JOIN cost is meaningless at our scale (<10k tasks, <100 PRs/day projected).

## Migration

- Forward-only `ALTER TABLE tasks ADD COLUMN routing_decision TEXT` (nullable).
- No backfill. Historic rows stay NULL. `buildShadowObservations` filters NULLs via `WHERE t.routing_decision IS NOT NULL`. Thompson treats untracked tasks as if they never happened — strictly correct (no synthetic priors, no fake observations).
- SQLite-native pattern: SQLite does NOT support `ADD COLUMN IF NOT EXISTS`. Idempotency is achieved via `try { db.exec(ALTER...) } catch { if (!/duplicate column/.test(err.message)) throw }`. Pattern lifted from existing migrations of `priority` and `attempts` columns.
- No formal migration runner exists in this repo. The ALTER lives inside the `SCHEMA` constant `db.exec` block at TaskStore construction — same shape as every existing column add. PR #362 accepted this as the in-repo migration convention.

## Implementation (shipped in PR #362)

1. `tasks` schema: add `routing_decision TEXT` (nullable) via the idempotent ALTER pattern.
2. `TaskStore.setRoutingDecision(taskId, decision: RoutingDecision)`: single UPDATE.
3. `TaskStore.getDb()`: raw `Database.Database` accessor for the shadow recorder + observations reader.
4. `src/pipeline/factory.ts:252`: after `const routing = classifyTask(...)`, call `taskStore.setRoutingDecision(task.id, routing)`, then `recordShadowDecision(taskStore.getDb(), {...observations: buildShadowObservations(...)})` wrapped in try/catch (shadow-logging failure must not break live routing).
5. `src/agents/bandit/observations.ts` (new): `buildShadowObservations(db, repo, role)` reads `pr_decisions JOIN tasks` and maps verdicts to rewards. Filters malformed JSON + NULL arms.
6. `src/agents/bandit/known-arms.ts` (new): duplicates the model-id list from `boot-config.ts:20-22`. Sync between the two is enforced manually today; a sync-assertion test is the next follow-up (tracked as `AUDIT-IFleet-88545b7d`).

## Out of scope (deferred to follow-ups)

- **Editor + reviewer-role shadow logging.** PR #362 wires architect role only. Adding editor + reviewer is a small follow-up using the same `buildShadowObservations(_, _, 'editor'|'reviewer')` API. Tripling the signal volume drops the time-to-KPI proportionally.
- **Live bandit routing override.** Gated on a documented 25% cost-per-task win in `routing_shadow_log`. Not in scope for any near-term sprint.
- **`KNOWN_MODEL_IDS` sync-assertion test.** `src/agents/bandit/known-arms.ts` duplicates `boot-config.ts:20-22` today; the audit finding `AUDIT-IFleet-88545b7d` tracks adding a vitest case that asserts both lists stay in sync.
- **Indexed routing queries.** "All tasks where architect=opus" would need a derived/generated column or `json_extract` index. Defer until a real query needs it.

## Consequences

**Positive**:
- M6 shadow signal starts accumulating from PR #362 forward. KPI gate becomes measurable.
- Routing context is in one place (`tasks` row), discoverable by future humans reading the schema.
- Adding routing metadata is a JSON field edit, not a schema migration.

**Negative**:
- Observation queries need a JOIN. Microseconds at our scale; flagged here so future query-tuners know the shape.
- The full model-id list is duplicated between `boot-config.ts` and `known-arms.ts`. Manual sync today, test-enforced sync next sprint (`AUDIT-IFleet-88545b7d`).

**Neutral**:
- Historic tasks (pre-PR #362) stay NULL forever. They contribute zero observations. Correct behaviour — we have no truthful record of their routing.
