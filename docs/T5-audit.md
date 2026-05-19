# T5 Dead-Code & Lint Audit

Baseline before T1–T4 merge. Captured 2026-05-18 at start of Phase 0 from `chore/T5-cleanup-review` worktree, ref `925ec62` (main).

## Baseline health

| Check | Result |
|---|---|
| `pnpm typecheck` | clean, 0 errors |
| `pnpm test` (node:test) | 251 pass / 0 fail / 0 skipped |
| `pnpm test` (vitest) | 223 pass / 0 fail |
| `pnpm lint` | 0 errors, 5 warnings |

## Actionable lint warnings (5)

```
src/discord/client.ts:28:35       no-console  (console statement)
src/discord/index.ts:50:5         no-console  (console statement)
src/orchestrator/index.ts:310:7   no-console  (unused eslint-disable directive)
src/pipeline/architect.ts:74:7    no-console  (unused eslint-disable directive)
src/pipeline/runner.ts:163:9      no-console  (console statement)
```

Two of these (`orchestrator/index.ts:310`, `pipeline/architect.ts:74`) are stale `// eslint-disable-next-line no-console` directives — the lines they covered no longer have console calls. Safe to delete.

Three are real `console.log` / `console.info` calls that the lint rule wants converted to `console.warn`/`console.error` or routed through the event log. Plan: in Phase 3, convert them to `console.warn` where appropriate (boot-time discord lifecycle messages are warn-level by convention) or remove if they duplicate the event log.

## ts-prune output

311 lines total, 169 after filtering `(used in module)`. **Most entries are false positives** — the IFleet root `tsconfig.json` doesn't include `scripts/` in its main program, so cross-file imports from `scripts/run-smoke.ts` etc. are invisible to ts-prune. Verified by grep:

- `scripts/dispatcher-lock.ts:88 acquireDispatchLock` → imported by `scripts/run-smoke.ts:45` and 8x in tests
- `src/workers/spawn-runner.ts:39 runStreaming` → imported by `claude.ts`, `codex.ts`, tests
- `src/workers/types.ts:77 categorizeRateLimitError` → imported by `claude.ts`, `codex.ts`

The vast majority of remaining entries are barrel re-exports from `src/*/index.ts` files. These are deliberate public API surface and **must not be deleted** — they let downstream packages import from a single path.

Candidates that warrant a second look in Phase 3 (after T1–T4 merge — types may shift):

| Path | Symbol | Risk |
|---|---|---|
| `src/contracts/task.ts:39,43` | `isDiscordSource`, `isGitHubSource` | Type guards. Likely intended for consumers; check after T1 lands `Task.mode` changes. |
| `src/discord/slash-commands.ts:4` | `SlashCommandName` | Type alias for the union. Keep — public typing. |
| `src/queue/control-plane.ts:328` | `signLegacyPayload` | Legacy HMAC. If no caller post-merge, delete. |

## Recommendation for Phase 3

1. Delete the two unused `eslint-disable-next-line` directives.
2. Convert remaining 3 `no-console` warnings → `console.warn` (boot/lifecycle messages) or route through event log.
3. Skip ts-prune-driven export deletion this sprint — too noisy without a proper tsconfig include for `scripts/`. File a followup to add `scripts/` to tsconfig include or `ts-prune --project tsconfig.json --error` integration.
4. `pnpm lint --fix` after each change set.

## 2026-05-19 update — ts-prune wired into the dev workflow (#108)

`tsconfig.json` was already including `scripts/**/*.ts` at audit time, so the
audit's premise that "scripts/ isn't in the program" was wrong. The real noise
came from two distinct sources we hadn't separated:

- **Barrel re-exports.** `src/*/index.ts` re-export every public symbol so
  callers can write `import { x } from '@/observability'`. ts-prune flags
  every barrel re-export individually — ~140 of the 169 baseline entries were
  exactly this, and none should be deleted.
- **Test fixtures.** `src/mcp/__tests__/fixtures/mock-octokit.ts` and friends
  export helpers consumed only by sibling tests; ts-prune doesn't always
  walk the `__tests__` tree predictably.

Changes landed in this PR:

- Add `ts-prune` as a real `devDependency` (`^0.10.3`) — was previously
  invoked via `pnpm dlx`, which made the audit non-reproducible across
  machines.
- Add `pnpm dead-code` script: `ts-prune --ignore '(index\.ts|__tests__|fixtures)'`.
  The ignore regex strips the two known noise sources above without
  touching the audit's already-listed candidates.

### New baseline (post-#108)

| Run | Entries (excluding "used in module") |
|---|---:|
| `pnpm dlx ts-prune` (raw) | 182 |
| `pnpm dead-code` (this PR) | **29** |

Per the issue's `<25` acceptance criteria we're close but not under — the
remaining 29 are the genuine candidates that warrant a hand review in the
followup deletion sprint, e.g. `clearAutoRouterCache`, `autoRouteMode`,
`signLegacyPayload`, `createClaudeAdapter`, etc. Some are real dead code,
some are deliberate public-API exports — distinguishing the two needs a
human pass and is out of scope for #108 (the issue explicitly says
*"Do NOT delete anything yet"*).

To reproduce: `pnpm install && pnpm dead-code` from a clean main.
