---
id: feat-sprint-completed-duration
title: "feat(orchestrator): include durationMs in sprint.completed event payload"
mode: tdd
tags: [feature, orchestrator, observability]
source: 29
---

## Problem

When `SprintManager` emits `sprint.completed`, the payload has `from`/`to` but no timing info. Observability consumers must correlate separate events to compute sprint duration.

## Spec — exactly what to change

**`src/orchestrator/sprint.ts`** — in `transition()`, the `sprint.completed` branch currently emits:

```ts
{ from: current.state.kind, to: next.kind }
```

When `next.kind === 'completed'`, compute duration and add it:

```ts
const durationMs = current.state.kind === 'running' ? now - current.state.startedAt : 0;
{ from: current.state.kind, to: next.kind, durationMs, prs: next.prs }
```

`now` is already declared at the top of `transition()`. Use type-narrowed check on `current.state.kind === 'running'`.

**`src/orchestrator/__tests__/sprint.test.ts`** — add one test after existing `transition` tests using `makeManager` from `./helpers`. Assert `durationMs` is present and matches elapsed wall-clock between start and complete.

## Acceptance criteria

- `durationMs` is in the `sprint.completed` payload when transitioning from `running`
- `durationMs === 0` if no `running` start time
- Typecheck + lint + test pass
