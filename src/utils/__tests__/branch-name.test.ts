import { describe, it, expect } from 'vitest';
import { titleToBranchName } from '../branch-name.js';

describe('titleToBranchName', () => {
  it('conventional prefix — feat', () => {
    expect(titleToBranchName(7, 'feat: add classifier module')).toBe(
      'feat/smoke-7-add-classifier-module',
    );
  });

  it('conventional prefix — fix', () => {
    expect(titleToBranchName(12, 'fix: resolve race condition')).toBe(
      'fix/smoke-12-resolve-race-condition',
    );
  });

  it('conventional prefix with scope stripped', () => {
    expect(titleToBranchName(3, 'feat(auth): add OAuth')).toBe(
      'feat/smoke-3-add-oauth',
    );
  });

  it('no prefix defaults to chore', () => {
    expect(titleToBranchName(9, 'Remove stale TODOs')).toBe(
      'chore/smoke-9-remove-stale-todos',
    );
  });

  it('special chars are stripped', () => {
    // "Add" is not a whitelisted type, so the colon-suffix ("new! feature???") is used
    // as rest and the folder defaults to chore.
    expect(titleToBranchName(5, 'Add: new! feature???')).toBe(
      'chore/smoke-5-new-feature',
    );
  });

  it('slug is truncated at 40 chars with no trailing hyphen', () => {
    // 'word '.repeat(9) produces a 44-char slug that, when sliced at 40,
    // ends with a hyphen boundary — verifying the trailing-strip step fires.
    // Without that step the slice would be "word-word-word-word-word-word-word-word-" (40 chars).
    const result = titleToBranchName(1, 'chore: ' + 'word '.repeat(9));
    const slug = result.replace('chore/smoke-1-', '');
    expect(slug).toBe('word-word-word-word-word-word-word-word');
  });

  it('degenerate — falls back to task when slug is empty', () => {
    expect(titleToBranchName(4, '???!!!')).toBe('chore/smoke-4-task');
  });

  it('numbers in title are preserved', () => {
    expect(titleToBranchName(8, 'chore: clean up v2 api')).toBe(
      'chore/smoke-8-clean-up-v2-api',
    );
  });
});
