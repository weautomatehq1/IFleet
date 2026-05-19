import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODE,
  SPRINT_MODES,
  detectExplicitMode,
  getModePrompt,
  isSprintMode,
  _internal,
} from '../modes.ts';

describe('modes — prompts', () => {
  it('exposes a distinct prompt for each of the 4 named modes plus standard', () => {
    const ralph = getModePrompt('ralph');
    const ulw = getModePrompt('ulw');
    const tdd = getModePrompt('tdd');
    const deslop = getModePrompt('deslop');
    const standard = getModePrompt('standard');
    const all = [ralph, ulw, tdd, deslop, standard];
    const unique = new Set(all);
    assert.equal(unique.size, 5, 'all 5 prompts must be distinct');
  });

  it('every prompt is under 500 chars (issue brief budget)', () => {
    for (const mode of SPRINT_MODES) {
      const p = getModePrompt(mode);
      assert.ok(p.length < 500, `${mode} prompt is ${p.length} chars (>= 500)`);
    }
  });

  it('falls back to standard when mode is null/undefined/unknown', () => {
    assert.equal(getModePrompt(null), _internal.STANDARD_PROMPT);
    assert.equal(getModePrompt(undefined), _internal.STANDARD_PROMPT);
    // @ts-expect-error — runtime guard for unknown value
    assert.equal(getModePrompt('bogus'), _internal.STANDARD_PROMPT);
  });

  it('ralph prompt mentions retry/persistence', () => {
    assert.match(getModePrompt('ralph'), /retr|persist/i);
  });

  it('ulw prompt mentions parallel/multi-file', () => {
    assert.match(getModePrompt('ulw'), /parallel|multi-file|multiple files/i);
  });

  it('tdd prompt mentions tests first', () => {
    assert.match(getModePrompt('tdd'), /tests? (come |first)|failing test/i);
  });

  it('deslop prompt mentions deletion/conventions', () => {
    assert.match(getModePrompt('deslop'), /deletion|conventions|slop/i);
  });

  it('default mode is "standard"', () => {
    assert.equal(DEFAULT_MODE, 'standard');
  });
});

describe('modes — isSprintMode guard', () => {
  it('accepts every named mode', () => {
    for (const m of SPRINT_MODES) assert.equal(isSprintMode(m), true);
  });
  it('rejects everything else', () => {
    assert.equal(isSprintMode('overnight'), false);
    assert.equal(isSprintMode(''), false);
    assert.equal(isSprintMode(null), false);
    assert.equal(isSprintMode(undefined), false);
    assert.equal(isSprintMode(42), false);
  });
});

describe('modes — detectExplicitMode', () => {
  it('reads mode from a label', () => {
    const got = detectExplicitMode({ labels: ['auto:ship', 'mode:ralph'], body: '' });
    assert.equal(got, 'ralph');
  });

  it('label is case-insensitive', () => {
    const got = detectExplicitMode({ labels: ['MODE:ULW'], body: '' });
    assert.equal(got, 'ulw');
  });

  it('reads mode from a body header line', () => {
    const got = detectExplicitMode({
      labels: [],
      body: 'mode: tdd\n\nplease write tests first',
    });
    assert.equal(got, 'tdd');
  });

  it('reads mode from a /slash prefix in the body', () => {
    const got = detectExplicitMode({ labels: [], body: '/deslop clean up the generated code' });
    assert.equal(got, 'deslop');
  });

  it('returns undefined when no signal is present', () => {
    const got = detectExplicitMode({ labels: ['auto:ship'], body: 'normal task' });
    assert.equal(got, undefined);
  });

  it('ignores unknown mode values', () => {
    const got = detectExplicitMode({ labels: ['mode:rampage'], body: '' });
    assert.equal(got, undefined);
  });
});
