// Unit tests for scoreKeywords word-boundary matching (ADR-0004 item 4).
//
// scoreKeywords is not exported directly, so we probe it through classifyTask:
// a text that scores ≥3 (one HIGH_KEYWORD hit) routes architect to Opus;
// a text that scores 0 routes to haiku (or sonnet via MEDIUM_KEYWORDS).
// False-positive cases must NOT reach Opus; positive controls must reach Opus.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../index.ts';

const LABELS = ['auto:ship'];

describe('scoreKeywords — word-boundary matching (ADR-0004 item 4)', () => {
  // --- false-positive negatives (substring must NOT match) ---

  it('"author of the PR" does NOT match HIGH keyword "auth" (substring false-positive)', () => {
    const result = classifyTask({
      title: 'author of the PR needs to review',
      body: '',
      labels: LABELS,
    });
    // No HIGH_KEYWORD word-boundary hit → haiku tier (score 0)
    assert.notEqual(
      result.architect.model,
      'claude-opus-4-7',
      'architect must NOT be Opus when "auth" only appears as substring of "author"',
    );
  });

  it('"noncritical bug" does NOT match HIGH keyword "critical" (substring false-positive)', () => {
    const result = classifyTask({
      title: 'noncritical bug in dashboard layout',
      body: '',
      labels: LABELS,
    });
    assert.notEqual(
      result.architect.model,
      'claude-opus-4-7',
      'architect must NOT be Opus when "critical" only appears as substring of "noncritical"',
    );
  });

  it('"authorization header" does NOT match HIGH keyword "auth" (substring false-positive)', () => {
    const result = classifyTask({
      title: 'add authorization header to fetch calls',
      body: '',
      labels: LABELS,
    });
    assert.notEqual(
      result.architect.model,
      'claude-opus-4-7',
      'architect must NOT be Opus when "auth" only appears as substring of "authorization"',
    );
  });

  // --- positive controls (whole-word matches must still fire) ---

  it('"auth flow broken" DOES match HIGH keyword "auth" (whole-word hit)', () => {
    const result = classifyTask({
      title: 'auth flow broken after token refresh',
      body: '',
      labels: LABELS,
    });
    assert.equal(
      result.architect.model,
      'claude-opus-4-7',
      'architect must be Opus when "auth" appears as a whole word',
    );
  });

  it('"critical security issue" DOES match HIGH keyword "critical" (whole-word hit)', () => {
    const result = classifyTask({
      title: 'critical security issue in session handling',
      body: '',
      labels: LABELS,
    });
    assert.equal(
      result.architect.model,
      'claude-opus-4-7',
      'architect must be Opus when "critical" appears as a whole word',
    );
  });
});
