// Regression cover for F5 — the PR opener ran `gh pr create --reviewer
// @monstersebas1`. The `@` prefix made `gh` reject the login, so `gh` exited
// non-zero *after* creating the PR, failing the whole task over a non-essential
// step. normalizeReviewers strips the `@` so `gh` gets a bare login.

import { describe, it, expect } from 'vitest';
import { normalizeReviewers } from '../factory.js';
import { classifyTask } from '../../classifier/index.js';

describe('F5: normalizeReviewers — gh-safe reviewer logins', () => {
  it('strips a leading @ (CODEOWNERS / config store @user)', () => {
    expect(normalizeReviewers(['@monstersebas1'])).toEqual(['monstersebas1']);
  });

  it('leaves bare logins untouched', () => {
    expect(normalizeReviewers(['monstersebas1', 'esmelyvaldivieso99-code'])).toEqual([
      'monstersebas1',
      'esmelyvaldivieso99-code',
    ]);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(normalizeReviewers(['@x', '', '  ', '@@y'])).toEqual(['x', 'y']);
  });

  it('returns an empty array when there are no reviewers', () => {
    expect(normalizeReviewers([])).toEqual([]);
  });
});

describe('AUDIT-IFleet-e8b8cbc4: classifyTask propagates mode from QueuedTask', () => {
  it('preserves mode: ralph in the routing decision', () => {
    const decision = classifyTask({
      title: 'fix broken widget',
      body: 'some body',
      labels: [],
      mode: 'ralph',
    });
    expect(decision.mode).toBe('ralph');
  });
});
