---
id: fix-empty-queue-error-message
title: "fix(scripts): replace hardcoded issue #6 reference in error message"
mode: default
tags: [bugfix, scripts, docs]
source: 17
---

## Problem

When the queue is empty, `run-smoke.ts` prints:

```
ERROR: No issues ready to pick. Ensure issue #6 has label auto:ship and is open.
```

This is hardcoded to issue #6 and is confusing once that issue is closed.

## Solution

Replace with a generic message:

```
ERROR: No issues ready to pick. Create a GitHub issue with the label auto:ship and rerun.
```

## Acceptance criteria

- Error message contains no hardcoded issue number
- Typecheck + lint + test pass
