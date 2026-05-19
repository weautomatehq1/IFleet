mode: ulw

# Rename `RoutingHints.priority` → `RoutingHints.urgency` across the codebase

The field is used by `parseLabels`, the classifier, the queue, and the
observability layer. The rename is mechanical but touches ~12 files. Plan a
parallel-safe edit set: shared types first (`src/queue/types.ts`), then the
leaf consumers (label parser, classifier, observability). The reviewer must
confirm no string literal `priority` references survive in routing code.

## Acceptance

- All `RoutingHints.priority` references renamed; tests still pass.
- A single migration note added to `docs/MODEL-ROUTING.md` under "label gates".
- No behavior change — this is a pure rename for clarity.
