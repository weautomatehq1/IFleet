import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateConfig } from '@wahq/orchestrator-core/queue/config';

describe('validateConfig', () => {
  it('accepts a well-formed config', () => {
    const cfg = validateConfig({ repos: [{ owner: 'a', name: 'b' }] });
    assert.deepEqual(cfg.repos, [{ owner: 'a', name: 'b' }]);
  });

  it('rejects missing repos array', () => {
    assert.throws(() => validateConfig({}));
  });

  it('rejects bad entries', () => {
    assert.throws(() => validateConfig({ repos: [{ owner: 'a' }] }));
    assert.throws(() => validateConfig({ repos: [{ name: 'b' }] }));
    assert.throws(() => validateConfig({ repos: ['not an object'] }));
  });
});
