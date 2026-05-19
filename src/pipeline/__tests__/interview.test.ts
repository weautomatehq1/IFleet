import { describe, it, expect } from 'vitest';
import {
  INTERVIEW_SYSTEM_PROMPT,
  isVagueBrief,
  parseInterviewQuestions,
} from '../interview.js';

describe('isVagueBrief', () => {
  it('flags a short brief (< 200 chars)', () => {
    expect(isVagueBrief('add a button')).toBe(true);
  });

  it('flags a long brief that lacks an ## Acceptance section', () => {
    const body = 'lorem '.repeat(80); // > 200 chars, no acceptance header
    expect(isVagueBrief(body)).toBe(true);
  });

  it('flags a long structured brief with more than 2 question marks', () => {
    const body = `## Goal

Ship the dashboard.

## Acceptance

- it works
- it ships
- but really? does it? actually? for sure?
`;
    expect(isVagueBrief(body)).toBe(true);
  });

  it('does NOT flag a long brief with an Acceptance section and at most 2 question marks', () => {
    const body = `## Goal

Ship the dashboard component with a new metric tile.

## Acceptance

- Metric tile renders the latest 24h count
- Loading state is visible while the query is in flight
- Empty state shows a help link
`;
    expect(isVagueBrief(body)).toBe(false);
  });

  it('flags a brief with 3 question marks AND < 200 chars (T1.md acceptance case)', () => {
    const body = 'do the thing? maybe? possibly?';
    expect(isVagueBrief(body)).toBe(true);
  });
});

describe('parseInterviewQuestions', () => {
  it('extracts numbered questions inside a <questions> block', () => {
    const out = parseInterviewQuestions(`
<questions>
1. Which page do you mean?
2. What does "fast" mean here — p50 < 100ms?
3. Should it work offline?
</questions>
`);
    expect(out).toEqual([
      'Which page do you mean?',
      'What does "fast" mean here — p50 < 100ms?',
      'Should it work offline?',
    ]);
  });

  it('strips dash/asterisk bullets and parenthesized indices', () => {
    const out = parseInterviewQuestions(`<questions>
- First?
* Second?
3) Third?
</questions>`);
    expect(out).toEqual(['First?', 'Second?', 'Third?']);
  });

  it('caps to 3 questions even if the architect emits more', () => {
    const out = parseInterviewQuestions(`<questions>
1. one
2. two
3. three
4. four
5. five
</questions>`);
    expect(out).toHaveLength(3);
    expect(out).toEqual(['one', 'two', 'three']);
  });

  it('returns [] when no <questions> block is present', () => {
    expect(parseInterviewQuestions('some plan text with no block')).toEqual([]);
  });
});

describe('INTERVIEW_SYSTEM_PROMPT', () => {
  it('instructs the model to wrap output in a <questions> block', () => {
    // Contract guard: if this string drifts, the parser stops finding the block.
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/<questions>/);
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/<\/questions>/);
  });
});
