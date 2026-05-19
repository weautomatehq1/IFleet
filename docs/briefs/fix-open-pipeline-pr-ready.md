---
id: fix-open-pipeline-pr-ready
title: "fix(scripts): open pipeline PRs as ready-to-merge, not draft"
mode: default
tags: [bugfix, scripts, dx]
source: 21
---

## Problem

`buildPrOpener()` in `scripts/run-smoke.ts` always passes `--draft` to `gh pr create`. Every pipeline PR requires a manual `gh pr ready <N>` before it can be merged, adding friction.

## Solution

Remove the `'--draft'` argument from the `gh pr create` call in `buildPrOpener()`. CI plus reviewer approval already gate the PR. Draft status adds no extra safety and slows down the review-merge loop.

## Acceptance criteria

- Pipeline PRs open in ready state (no draft label on GitHub)
- Smoke run completes green end-to-end
- Typecheck + lint + test pass
