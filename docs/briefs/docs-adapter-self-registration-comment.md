---
id: docs-adapter-self-registration-comment
title: "docs(adapters): update index.ts comment to explain pipeline-registry self-registration"
mode: default
tags: [docs, adapters]
source: 66
---

## Problem

The comment at the top of `src/workers/adapters/index.ts` says:

> Import every adapter module so each one's `registerAdapter(...)` runs at load time. Adding a new backend = drop a file in this folder + add it here.

This is now misleading. It only mentions `import './claude-cli.ts'` and implies every adapter needs an explicit side-effect import. But `pipeline-registry.ts` uses a different mechanism: it self-registers at the bottom of the module and activates via its re-export (no separate `import './pipeline-registry.ts'` line needed).

## Expected behaviour

The comment should accurately describe **both** registration patterns:

1. **Orchestrator-level adapters** (e.g. `claude-cli.ts`) — explicit `import './module.ts'` side-effect triggers `registerAdapter(...)`.
2. **Pipeline-level adapters** (e.g. `pipeline-registry.ts`) — self-registers at module bottom; the re-export `export { ... } from './pipeline-registry.ts'` is sufficient to trigger it.

## Acceptance criteria

- The comment block at the top of `src/workers/adapters/index.ts` (lines 1–3) is updated to explain both patterns.
- `pnpm exec tsc --noEmit` passes.
- No other files changed.

## Out of scope

- Changing the registration mechanism itself.
- Renaming any exports.
