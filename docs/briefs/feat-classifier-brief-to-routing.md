---
id: feat-classifier-brief-to-routing
title: "feat(classifier): build brief → routing decision module"
mode: ulw
tags: [feature, classifier]
source: 20
---

## Context

`config/routing.json` defines keyword and file-glob rules for picking provider/model per task. Nothing reads it yet — routing is hardcoded in `scripts/run-smoke.ts`.

## Goal

Build `src/classifier/index.ts` that exports:

```ts
export function classifyTask(task: { title: string; body: string; labels: string[] }): RoutingDecision
```

- Load `config/routing.json` at startup
- Match task title + body against `rules[].match.keywords` (case-insensitive substring)
- Fall through to `pipeline` defaults when no rule matches
- Return a `RoutingDecision` shaped like the existing type in `src/pipeline/types.ts`

## Acceptance criteria

- `classifyTask` returns correct provider/model for keyword matches
- Falls back to `pipeline.architect` / `pipeline.editor` defaults when no rule matches
- Unit tests cover: keyword hit, no match (default), multi-rule priority (first match wins)
- Typecheck + lint + test pass
