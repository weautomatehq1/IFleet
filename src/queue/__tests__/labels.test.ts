import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseLabels, parseRequiredCapabilities } from '../labels.js';

describe('parseLabels', () => {
  it('defaults when no routing labels present', () => {
    const hints = parseLabels(['bug', 'good first issue']);
    assert.equal(hints.priority, 'normal');
    assert.equal(hints.autonomy, 'auto');
    assert.equal(hints.model, undefined);
    assert.deepEqual(hints.verify, ['typecheck', 'lint', 'test']);
  });

  it('parses model and priority', () => {
    const hints = parseLabels(['auto:ship', 'model:opus', 'priority:high']);
    assert.equal(hints.model, 'opus');
    assert.equal(hints.priority, 'high');
  });

  it('ignores unknown model/priority values', () => {
    const hints = parseLabels(['model:bogus', 'priority:weird']);
    assert.equal(hints.model, undefined);
    assert.equal(hints.priority, 'normal');
  });

  it('verify:ui adds playwright and screenshot', () => {
    const hints = parseLabels(['verify:ui']);
    assert.deepEqual(hints.verify.sort(), ['playwright', 'screenshot']);
  });

  it('verify:none clears verify list only with autonomy:auto', () => {
    const cleared = parseLabels(['verify:none']);
    assert.deepEqual(cleared.verify, []);

    const blocked = parseLabels(['verify:none', 'autonomy:review']);
    assert.deepEqual(blocked.verify, ['typecheck', 'lint', 'test']);
    assert.equal(blocked.autonomy, 'review');
  });

  it('verify:<kind> overrides defaults and is order-insensitive', () => {
    const hints = parseLabels(['verify:test', 'verify:lint']);
    assert.deepEqual(hints.verify.sort(), ['lint', 'test']);
  });

  it('autonomy:review is respected', () => {
    const hints = parseLabels(['autonomy:review']);
    assert.equal(hints.autonomy, 'review');
  });

  it('handles case and whitespace', () => {
    const hints = parseLabels([' Model:Sonnet ', 'Priority:LOW']);
    assert.equal(hints.model, 'sonnet');
    assert.equal(hints.priority, 'low');
  });

  it('every routing combination produces consistent shape', () => {
    const models = ['opus', 'sonnet', 'haiku', 'codex'] as const;
    const priorities = ['low', 'normal', 'high'] as const;
    const autonomies = ['auto', 'review'] as const;
    for (const m of models) {
      for (const p of priorities) {
        for (const a of autonomies) {
          const hints = parseLabels([`model:${m}`, `priority:${p}`, `autonomy:${a}`]);
          assert.equal(hints.model, m);
          assert.equal(hints.priority, p);
          assert.equal(hints.autonomy, a);
          assert.ok(Array.isArray(hints.verify));
        }
      }
    }
  });
});

describe('parseRequiredCapabilities', () => {
  it('returns empty array for labels with no requires: prefix', () => {
    assert.deepEqual(parseRequiredCapabilities(['bug', 'auto:ship', 'priority:high']), []);
  });

  it('parses a single requires: label', () => {
    assert.deepEqual(parseRequiredCapabilities(['requires:docker']), ['docker']);
  });

  it('parses multiple requires: labels and ignores non-requires labels', () => {
    const result = parseRequiredCapabilities(['auto:ship', 'requires:docker', 'bug', 'requires:gh']);
    assert.deepEqual(result, ['docker', 'gh']);
  });

  it('skips requires: with empty value', () => {
    assert.deepEqual(parseRequiredCapabilities(['requires:']), []);
  });

  it('lowercases the capability name', () => {
    assert.deepEqual(parseRequiredCapabilities(['Requires:Docker']), ['docker']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseRequiredCapabilities([]), []);
  });
});
