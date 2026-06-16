import { describe, expect, it } from 'vitest';
import { KNOWN_MODEL_IDS } from '../known-arms.js';
import { KNOWN_MODEL_SHORTHAND } from '../../../orchestrator/handlers/boot-config.js';

describe('KNOWN_MODEL_IDS ↔ boot-config sync', () => {
  const bootFullIds = [...KNOWN_MODEL_SHORTHAND].filter(m => m.startsWith('claude-'));

  it('every full-ID in boot-config appears in known-arms', () => {
    for (const id of bootFullIds) {
      expect(KNOWN_MODEL_IDS).toContain(id);
    }
  });

  it('every known-arm ID appears in boot-config', () => {
    for (const id of KNOWN_MODEL_IDS) {
      expect(KNOWN_MODEL_SHORTHAND.has(id)).toBe(true);
    }
  });
});
