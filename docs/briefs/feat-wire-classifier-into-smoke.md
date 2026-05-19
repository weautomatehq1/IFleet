---
id: feat-wire-classifier-into-smoke
title: "feat(scripts): wire classifier into run-smoke.ts routing"
mode: default
tags: [feature, scripts]
source: 22
---

## Context

Depends on: classifier module from `feat-classifier-brief-to-routing`.

`run-smoke.ts` hardcodes routing:

```ts
const claudeSpec: WorkerSpec = { provider: 'claude', model: 'claude-sonnet-4-6', workerId: 'claude-max-1' };
const routing: RoutingDecision = { architect: claudeSpec, editor: claudeSpec, reviewer: reviewerSpec, verify: rawTask.routingHints.verify };
```

## Goal

Replace hardcoded routing with a call to `classifyTask`:

```ts
import { classifyTask } from '../src/classifier/index.ts';
const routing = classifyTask({ title: rawTask.title, body: rawTask.body, labels: rawTask.labels });
```

## Acceptance criteria

- Routing is driven by `classifyTask` output
- No hardcoded `WorkerSpec` in the routing block
- Smoke run completes green
- Typecheck + lint + test pass
