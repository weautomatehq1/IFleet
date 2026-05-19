# IFleet Invariants

Architectural constraints encoded as machine-checkable rules. Two formats run in parallel:

- **semgrep.yml** — static pattern rules enforced at the AST level (Semgrep ≥1.40)
- **arch.ts** — dependency-graph assertions run as a Node script (no external deps)

## Who reads these

| Reader | When |
|---|---|
| Architect agent | At plan time — before writing code, to know what's off-limits |
| VerifierAgent (M1.W4) | At gate time — run against every PR before it can merge |
| Human reviewer | When adding a new rule — as the source of truth for "why" |

## How the invariant runner uses them

`src/agents/verifier/invariants.ts` invokes:
1. `npx semgrep --config .ifleet/invariants/weautomatehq1_IFleet/semgrep.yml <paths>`
2. `npx tsx .ifleet/invariants/weautomatehq1_IFleet/arch.ts`

Any non-zero exit or stdout line starting with `VIOLATION:` is treated as a failure and
re-queued to the Editor with structured feedback.

## Adding a new rule

**Semgrep rule:**
1. Add an entry to `semgrep.yml` — follow the existing `id`/`message`/`severity` pattern.
2. Set `severity: ERROR` for load-bearing constraints (blocks merge), `WARNING` for advisories.
3. Validate locally: `npx semgrep --validate -f semgrep.yml`
4. Add a comment block explaining which CLAUDE.md rule or ADR this enforces.

**Arch assertion:**
1. Add a `checkRule(...)` call inside `arch.ts`'s `main()`.
2. The checker scans import statements in source files — see existing examples.
3. Run `pnpm exec tsc -p tsconfig.ifleet.json --noEmit` to confirm it compiles.
4. Run `npx tsx arch.ts` from the repo root to smoke-test before committing.

## Rule inventory

| ID | Format | Enforces |
|---|---|---|
| `no-github-outside-queue` | semgrep | SprintManager emits events, never calls GitHub directly (CLAUDE.md architecture rule) |
| `no-haiku-in-editor` | semgrep | Editor must be Sonnet floor — never Haiku (PR #73) |
| `no-no-verify` | semgrep | Never skip git hooks (global CLAUDE.md) |
| `no-env-outside-config` | semgrep | Centralise `process.env` reads in `src/config/` |
| `sprint-no-queue-import` | arch | `src/orchestrator/sprint.ts` must not import from `src/queue/` |
| `pipeline-no-discord-import` | arch | `src/pipeline/**` must not import from `src/discord/**` |
| `no-test-imports-in-src` | arch | Test files (`*.test.ts`) must not be imported by non-test code |
