---
id: fix-derive-branch-name
title: "fix(scripts): derive branch name from issue title in run-smoke.ts"
mode: default
tags: [bugfix, scripts]
source: 16
---

## Problem

The branch name in `run-smoke.ts` is hardcoded:

```ts
const branchName = `chore/smoke-${rawTask.issueNumber}-remove-stale-todo`;
```

This only works for the original issue. Any new issue gets a branch named after the stale TODO task.

## Solution

Derive the branch name from `rawTask.title` at runtime:

- Lowercase the title
- Replace spaces and special chars with `-`
- Collapse repeated dashes
- Truncate to ~50 chars
- Prefix with the conventional-commit prefix from the title (`feat/`, `fix/`, `chore/`) and the issue number

Example: issue #7 "feat: add classifier module" → `feat/smoke-7-add-classifier-module`.

## Acceptance criteria

- Branch name reflects the picked issue's title
- No hardcoded string references
- Typecheck + lint + test pass
