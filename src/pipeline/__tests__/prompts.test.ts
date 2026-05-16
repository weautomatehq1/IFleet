import { describe, it, expect } from 'vitest';
import {
  buildArchitectPrompt,
  buildEditorPrompt,
  ARCHITECT_SYSTEM_PROMPT,
  EDITOR_SYSTEM_PROMPT,
  ARCHITECT_ULW_ADDENDUM,
  ARCHITECT_TDD_ADDENDUM,
  EDITOR_RALPH_ADDENDUM,
  EDITOR_ULW_ADDENDUM,
  EDITOR_TDD_ADDENDUM,
  EDITOR_DESLOP_ADDENDUM,
} from '../prompts.js';
import type { SprintMode } from '../types.js';

const ALL_MODES: SprintMode[] = ['ralph', 'ulw', 'tdd', 'deslop', 'default'];

describe('buildEditorPrompt', () => {
  it('each mode produces a unique string', () => {
    const prompts = ALL_MODES.map(buildEditorPrompt);
    expect(new Set(prompts).size).toBe(ALL_MODES.length);
  });

  it('default mode returns EDITOR_SYSTEM_PROMPT unchanged', () => {
    expect(buildEditorPrompt('default')).toBe(EDITOR_SYSTEM_PROMPT);
  });

  it.each(['ralph', 'ulw', 'tdd', 'deslop'] as const)(
    '%s mode differs from default',
    (mode) => {
      expect(buildEditorPrompt(mode)).not.toBe(EDITOR_SYSTEM_PROMPT);
    },
  );

  it('ralph appends EDITOR_RALPH_ADDENDUM', () => {
    expect(buildEditorPrompt('ralph')).toContain(EDITOR_RALPH_ADDENDUM);
  });

  it('ulw appends EDITOR_ULW_ADDENDUM', () => {
    expect(buildEditorPrompt('ulw')).toContain(EDITOR_ULW_ADDENDUM);
  });

  it('tdd appends EDITOR_TDD_ADDENDUM', () => {
    expect(buildEditorPrompt('tdd')).toContain(EDITOR_TDD_ADDENDUM);
  });

  it('deslop appends EDITOR_DESLOP_ADDENDUM', () => {
    expect(buildEditorPrompt('deslop')).toContain(EDITOR_DESLOP_ADDENDUM);
  });
});

describe('buildArchitectPrompt', () => {
  it('default mode returns ARCHITECT_SYSTEM_PROMPT unchanged', () => {
    expect(buildArchitectPrompt('default')).toBe(ARCHITECT_SYSTEM_PROMPT);
  });

  it('ralph does not change the architect prompt', () => {
    expect(buildArchitectPrompt('ralph')).toBe(ARCHITECT_SYSTEM_PROMPT);
  });

  it('deslop does not change the architect prompt', () => {
    expect(buildArchitectPrompt('deslop')).toBe(ARCHITECT_SYSTEM_PROMPT);
  });

  it('ulw appends ARCHITECT_ULW_ADDENDUM', () => {
    expect(buildArchitectPrompt('ulw')).toContain(ARCHITECT_ULW_ADDENDUM);
    expect(buildArchitectPrompt('ulw')).not.toBe(ARCHITECT_SYSTEM_PROMPT);
  });

  it('tdd appends ARCHITECT_TDD_ADDENDUM', () => {
    expect(buildArchitectPrompt('tdd')).toContain(ARCHITECT_TDD_ADDENDUM);
    expect(buildArchitectPrompt('tdd')).not.toBe(ARCHITECT_SYSTEM_PROMPT);
  });

  it('ulw and tdd produce different prompts from each other', () => {
    expect(buildArchitectPrompt('ulw')).not.toBe(buildArchitectPrompt('tdd'));
  });

  it('each unique-output mode produces a unique architect prompt', () => {
    const prompts = ALL_MODES.map(buildArchitectPrompt);
    // default, ralph, deslop all return the same base — only ulw and tdd differ
    // So at minimum 3 unique prompts (base, ulw, tdd)
    const unique = new Set(prompts);
    expect(unique.size).toBeGreaterThanOrEqual(3);
    // ulw and tdd each produce a distinct string from the base
    expect(buildArchitectPrompt('ulw')).not.toBe(ARCHITECT_SYSTEM_PROMPT);
    expect(buildArchitectPrompt('tdd')).not.toBe(ARCHITECT_SYSTEM_PROMPT);
    expect(buildArchitectPrompt('ulw')).not.toBe(buildArchitectPrompt('tdd'));
  });
});
