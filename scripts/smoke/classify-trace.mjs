#!/usr/bin/env node
// Smoke 1 — plan-reviewer floor + opus cap, traced through classifyTask().
//
// Purpose: prove at the source-of-truth level that classifyTask() (the
// runtime routing function used by src/pipeline/runner.ts) returns a
// plan-reviewer model that is never below the configured floor (sonnet),
// and that the architect does not auto-promote to opus without an explicit
// `complexity:high` label.
//
// This script is the committed, reproducible companion to the smoke-run
// entries in `.ifleet/smoke-runs/`. It deliberately calls the *exported*
// routing function rather than re-asserting unit-test expectations — the
// goal is to print the verbatim runtime decision shape so a human reviewer
// can compare against the spec in docs/elevation/upgrades/02-plan-reviewer.md
// without trusting any test fixtures.
//
// Usage:
//   node --import tsx scripts/smoke/classify-trace.mjs
//
// Exit code is 0 even on a floor violation — the smoke-run file is the
// verdict, not the exit code. The operator inspects the printed table.

import { classifyTask } from '../../src/classifier/index.ts';

const cases = [
  {
    name: 'complexity:high + security keywords',
    input: {
      title: 'audit auth bypass and rotate tokens',
      body: 'security review of jwt secrets and oauth callback',
      labels: ['auto:ship', 'complexity:high', 'autonomy:auto'],
    },
  },
  {
    name: 'no high signal (UI polish)',
    input: {
      title: 'tweak hero spacing',
      body: 'shift the headline 4px down on mobile',
      labels: ['auto:ship', 'autonomy:auto'],
    },
  },
  {
    name: 'docs label only',
    input: {
      title: 'fix typo in README',
      body: 'replace "teh" with "the"',
      labels: ['auto:ship', 'docs'],
    },
  },
  {
    name: 'security keywords WITHOUT complexity:high',
    input: {
      title: 'review session token storage',
      body: 'audit how we persist JWTs in localStorage',
      labels: ['auto:ship', 'autonomy:auto'],
    },
  },
];

const rows = cases.map(({ name, input }) => {
  const decision = classifyTask({ ...input, mode: null });
  return {
    name,
    architect: decision.architect?.model ?? '(none)',
    editor: decision.editor?.model ?? '(none)',
    planReviewer: decision.planReviewer?.model ?? '(none)',
    verify: (decision.verify ?? []).join(',') || '(none)',
  };
});

console.log(JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
