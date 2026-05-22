// Regression cover for F4 — the editor opened PR #179 out-of-band because the
// architect's plan included push/PR steps and the editor follows the plan
// ("trusted — follow this"). The pipeline opens the PR only after CI passes;
// both prompts must keep the no-version-control guard or the bug returns.

import { describe, it, expect } from 'vitest';
import { ARCHITECT_SYSTEM_PROMPT, EDITOR_SYSTEM_PROMPT } from '../prompts.js';

describe('F4: pipeline owns version control, not the workers', () => {
  it('architect prompt forbids planning git / push / PR steps', () => {
    expect(ARCHITECT_SYSTEM_PROMPT).toMatch(/pull-request steps/i);
    expect(ARCHITECT_SYSTEM_PROMPT).toMatch(/opens the PR/i);
  });

  it('editor prompt forbids running gh / opening pull requests', () => {
    expect(EDITOR_SYSTEM_PROMPT).toMatch(/git or gh commands/i);
    expect(EDITOR_SYSTEM_PROMPT).toMatch(/open pull requests/i);
    // Must override the plan — the plan is marked "trusted" to the editor.
    expect(EDITOR_SYSTEM_PROMPT).toMatch(/even if the plan/i);
  });
});
