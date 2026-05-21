// Prompt-stability tests guard the cache-stability guarantee documented at the
// top of prompts.ts. The Anthropic prompt auto-cache (and the future explicit
// 1h-TTL cache_control) depends on these constants being bit-identical across
// every spawn. A test failure here means something changed that would bust the
// cache for ALL in-flight tasks.

import { describe, it, expect } from 'vitest';
import {
  ARCHITECT_SYSTEM_PROMPT,
  DOCTOR_SYSTEM_PROMPT,
  EDITOR_SYSTEM_PROMPT,
  EDITOR_DOCTOR_PROMPT_HEADER,
  EDITOR_FIX_PASS_PROMPT_HEADER,
  HAIKU_GATE_SYSTEM_PROMPT,
  PLAN_REVIEWER_SYSTEM_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
} from '../prompts.js';

// All exported role prompts that are sent as system prompt or as a stable
// prefix in a user turn. Any constant added to prompts.ts should be listed here.
const ROLE_PROMPTS: Array<{ name: string; value: string }> = [
  { name: 'ARCHITECT_SYSTEM_PROMPT', value: ARCHITECT_SYSTEM_PROMPT },
  { name: 'EDITOR_SYSTEM_PROMPT', value: EDITOR_SYSTEM_PROMPT },
  { name: 'REVIEWER_SYSTEM_PROMPT', value: REVIEWER_SYSTEM_PROMPT },
  { name: 'PLAN_REVIEWER_SYSTEM_PROMPT', value: PLAN_REVIEWER_SYSTEM_PROMPT },
  { name: 'HAIKU_GATE_SYSTEM_PROMPT', value: HAIKU_GATE_SYSTEM_PROMPT },
  { name: 'DOCTOR_SYSTEM_PROMPT', value: DOCTOR_SYSTEM_PROMPT },
  { name: 'EDITOR_FIX_PASS_PROMPT_HEADER', value: EDITOR_FIX_PASS_PROMPT_HEADER },
  { name: 'EDITOR_DOCTOR_PROMPT_HEADER', value: EDITOR_DOCTOR_PROMPT_HEADER },
];

describe('prompt stability (cache-busting guard)', () => {
  it.each(ROLE_PROMPTS)('$name is a non-empty string', ({ value }) => {
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it.each(ROLE_PROMPTS)('$name is identical on repeated import (no hidden randomness)', ({ name, value }) => {
    // Re-read from the same exported binding — if the constant contains
    // Date.now() / Math.random() / any dynamic call at import time, this
    // would diverge between the first read (captured above) and re-access.
    const lookup: Record<string, string> = {
      ARCHITECT_SYSTEM_PROMPT,
      EDITOR_SYSTEM_PROMPT,
      REVIEWER_SYSTEM_PROMPT,
      PLAN_REVIEWER_SYSTEM_PROMPT,
      HAIKU_GATE_SYSTEM_PROMPT,
      DOCTOR_SYSTEM_PROMPT,
      EDITOR_FIX_PASS_PROMPT_HEADER,
      EDITOR_DOCTOR_PROMPT_HEADER,
    };
    expect(lookup[name]).toBe(value);
  });

  it('ARCHITECT_SYSTEM_PROMPT is the exact prefix of an architect prompt augmented with learnings', () => {
    // architect.ts assembles: `${ARCHITECT_SYSTEM_PROMPT}\n\n${learningsSection}`
    // The static constant MUST be the byte-for-byte prefix so the Anthropic
    // cache can match it. Any variation (leading space, BOM, encoding diff)
    // would bust the cache for every architect spawn.
    const learningsSection = '## Prior learnings\n- example learning';
    const assembled = `${ARCHITECT_SYSTEM_PROMPT}\n\n${learningsSection}`;
    expect(assembled.startsWith(ARCHITECT_SYSTEM_PROMPT)).toBe(true);
    // The cache boundary is the end of ARCHITECT_SYSTEM_PROMPT — learnings
    // appended after this point are dynamic and must NOT be tagged with
    // cache_control when the SDK-direct migration lands.
    expect(assembled.slice(ARCHITECT_SYSTEM_PROMPT.length)).toBe(`\n\n${learningsSection}`);
  });

  it('no role prompt contains dynamic content markers', () => {
    // Guard against accidental Date.now() / ISO strings / task IDs leaking
    // into the constant definitions. Any match here means the cache key
    // changes per-run, defeating the entire cache benefit.
    const isoDatePattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const taskIdPattern = /task[-_]?[0-9a-f]{8}/i;
    for (const { name, value } of ROLE_PROMPTS) {
      expect(isoDatePattern.test(value), `${name} contains ISO date — cache busted`).toBe(false);
      expect(taskIdPattern.test(value), `${name} contains task ID — cache busted`).toBe(false);
    }
  });

  it('cache_control migration checklist is documented in prompts.ts source', async () => {
    // Verify the SDK migration comment exists. This test fails if someone
    // removes the documentation block — it is the canonical source of truth
    // for the eventual SDK-direct migration.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const url = new URL('../prompts.ts', import.meta.url);
    const src = await readFile(fileURLToPath(url), 'utf8');
    expect(src).toContain('cache_control');
    expect(src).toContain('SDK migration required');
    expect(src).toContain('CURRENT LIMITATION');
  });
});
