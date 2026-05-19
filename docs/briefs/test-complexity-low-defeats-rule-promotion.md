---
id: test-complexity-low-defeats-rule-promotion
title: "test(classifier): complexity:low must defeat a rule-driven opus promotion"
mode: tdd
tags: [test, classifier]
source: 43
---

## Context

PR #41 introduced the policy that the architect role runs on Sonnet by default and is only promoted to Opus when the issue carries a `complexity:high` label. `complexity:low` is also supposed to force Sonnet even when something else (scorer or routing rule) would otherwise push to Opus.

The PR ships an explicit test for `complexity:low` defeating a **scorer-driven** Opus promotion. It does not test the same outcome for a **rule-driven** Opus promotion (the routing rules that hardcode Opus for architect, like the SQL/migrations rule). The behaviour is correct by code trace but not exercised by the test suite.

## Acceptance criteria

- A new unit test exists that:
  - Submits a task whose title or body matches a routing rule mapping `architect → claude-opus-4-7`
  - Includes `complexity:low` in the labels
  - Asserts the resulting architect model resolves to `claude-sonnet-4-6`
- A second unit test asserts the same outcome when no complexity label is present at all (the default cap), distinct from the `complexity:low` case
- All existing tests still pass

## Out of scope

- Changing the routing rule shape or schema
- Refactoring the classifier
- Adding new label types
