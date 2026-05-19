---
id: chore-remove-stale-tx-todos
title: "chore: remove stale \"until Tx lands\" TODO comments"
mode: deslop
tags: [chore, refactor]
source: 6
---

## Problem

After a multi-PR merge, several TODO comments referencing in-flight terminals are stale and create noise during review:

- `src/orchestrator/sprint.ts:22` references "until T3 lands" — T3 has landed.
- `src/orchestrator/types.ts:81` references "until T2 lands" — T2 has landed.

## Acceptance criteria

- The stale comment lines are removed (comments only, no code changes).
- The imports immediately below them still resolve cleanly.
- `pnpm test` continues to pass with the same test count.

## Out of scope

- Any code restructuring beyond comment deletion.
- Renaming or moving the affected types.
