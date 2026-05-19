---
id: fix-reviewer-not-weaker-than-architect
title: "fix(classifier): reviewer must not resolve weaker than architect on rule-override paths"
mode: ralph
tags: [bugfix, classifier]
source: 44
---

## Symptom

For tasks where the scorer would have chosen a low tier (e.g. Haiku) but a routing rule promotes the architect, the reviewer slot keeps mirroring the scorer-derived tier instead of tracking the architect's final model. The reviewer can therefore end up weaker than the architect on the same task.

## Why it matters

The reviewer's job is a second opinion at architect strength. A weaker reviewer can rubber-stamp work that a stronger architect produced, which defeats the cross-check the pipeline relies on.

## Reproduction

1. Open an issue with a title matching an architect routing rule (e.g. mentioning "design", "security review", or "migration").
2. Do not add `complexity:high`, `priority:high`, or any other tier-bumping label.
3. Run the classifier on this task.
4. Observe the architect resolves to Sonnet (rule-promoted) while the reviewer resolves to Haiku.

## Acceptance criteria

- The reviewer's model is always at the same tier or higher than the architect's model in the same classification result.
- Invariant holds across every path: scorer-only, rule-override, complexity label, manual override.
- New regression tests cover each of the four paths.
- Typecheck + lint + test pass.
