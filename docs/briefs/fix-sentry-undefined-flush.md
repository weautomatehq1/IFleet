---
id: fix-sentry-undefined-flush
title: "fix(pipeline): guard runPipeline against undefined Sentry client on flush"
mode: ralph
tags: [bugfix, observability, sentry]
source: 80
---

## Symptom

Sentry issue: `TypeError: Cannot read properties of undefined (reading 'flush')` thrown from `src/pipeline/runner.ts` inside `runPipeline`.

## Hypothesis

The pipeline runner calls `sentry.flush()` at end-of-run. When Sentry is disabled in dev or when the init step bailed out (missing DSN), the module-level `sentry` reference is `undefined`. The call site does not guard the access.

## Repro

1. Unset `SENTRY_DSN`.
2. Trigger a pipeline run via `scripts/run-smoke.ts`.
3. Observe the crash at runtime when the runner reaches the cleanup hook.

## Acceptance criteria

- `runPipeline` cleanup uses optional chaining or an explicit guard before calling `flush`.
- A unit test covers the runner exiting cleanly when no Sentry client is configured.
- Existing Sentry-enabled path still flushes events on success and failure.
- Typecheck + lint + test pass.

## Out of scope

- Re-architecting Sentry initialisation.
- Adding new Sentry tags or spans.
