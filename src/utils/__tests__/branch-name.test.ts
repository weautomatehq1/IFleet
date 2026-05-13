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
    expect(titleToBranchName(5, 'Add: new! feature???')).toBe(
      'chore/smoke-5-add-new-feature',
    );
  });

  it('slug is truncated at 40 chars with no trailing hyphen', () => {
    const longTitle = 'chore: ' + 'a'.repeat(50);
    const result = titleToBranchName(1, longTitle);
    const slug = result.replace('chore/smoke-1-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
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
