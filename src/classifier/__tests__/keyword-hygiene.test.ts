// Fail CI if any HIGH_KEYWORDS entry word-boundary-matches inside another
// HIGH_KEYWORDS entry. Prevents regression of ADR-0004 item 4 (PR #392):
// a substring keyword would silently alias the longer one (e.g. adding
// "authorization" when "auth" exists would make "authorization" score +6).
// Uses the same \b-regex logic as the production scoreKeywords path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HIGH_KEYWORDS } from '../index.ts';

function escapeRegex(kw: string): string {
  return kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('HIGH_KEYWORDS hygiene — no word-boundary substring conflicts', () => {
  for (const kwA of HIGH_KEYWORDS) {
    for (const kwB of HIGH_KEYWORDS) {
      if (kwA === kwB) continue;
      it(`"${kwA}" does not word-boundary-match inside "${kwB}"`, () => {
        const matches = new RegExp(`\\b${escapeRegex(kwA)}\\b`, 'i').test(kwB);
        assert.ok(
          !matches,
          `HIGH_KEYWORDS conflict: "${kwA}" matches as whole-word inside "${kwB}" — ` +
            `scoring would double-count this pair; rename or merge the entries`,
        );
      });
    }
  }
});
