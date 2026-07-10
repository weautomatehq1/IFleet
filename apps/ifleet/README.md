# @wahq/ifleet

Workspace-member view of the IFleet app.

**Least-churn note:** the IFleet source has *not* been physically moved into
this directory. It stays at the repo root (`../../src`, `../../scripts`,
`../../dashboard`) because runtime consumers reference those paths literally —
`ecosystem.config.cjs` (PM2 `script:` entries), `.github/workflows/`, `.husky/`
hooks, `vitest.config.ts` globs, and the root `package.json` bin/scripts. Moving
the tree would break all of them and violate the Phase 0 behavior-freeze bar.

Instead this package's `build` / `typecheck` run `tsc --noEmit` against the
root `tsconfig.json`, so `pnpm -r build` type-checks the real app source in
place. When the shared engine is extracted into `@wahq/orchestrator-core`
(BUILD-PLAN T2), the app can migrate here incrementally.
