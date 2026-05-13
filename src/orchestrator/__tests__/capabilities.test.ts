import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isCapabilityAvailable, type Capabilities } from '../capabilities';

const CAPS: Capabilities = {
  version: '1',
  updated: '2026-05-13',
  shells: ['bash', 'zsh'],
  clis: { node: '24.0', Docker: '29.0' },
  mcps: ['github', 'SearXNG'],
  auth: { github: true },
};

describe('isCapabilityAvailable', () => {
  it('matches shell names case-insensitively', () => {
    assert.equal(isCapabilityAvailable('zsh', CAPS), true);
    assert.equal(isCapabilityAvailable('ZSH', CAPS), true);
    assert.equal(isCapabilityAvailable('fish', CAPS), false);
  });

  it('matches cli keys case-insensitively including mixed-case manifest keys', () => {
    assert.equal(isCapabilityAvailable('node', CAPS), true);
    assert.equal(isCapabilityAvailable('Node', CAPS), true);
    assert.equal(isCapabilityAvailable('docker', CAPS), true); // key in manifest is 'Docker'
    assert.equal(isCapabilityAvailable('DOCKER', CAPS), true);
    assert.equal(isCapabilityAvailable('python3', CAPS), false);
  });

  it('matches mcp names case-insensitively', () => {
    assert.equal(isCapabilityAvailable('github', CAPS), true);
    assert.equal(isCapabilityAvailable('GitHub', CAPS), true);
    assert.equal(isCapabilityAvailable('searxng', CAPS), true); // entry in manifest is 'SearXNG'
    assert.equal(isCapabilityAvailable('discord', CAPS), false);
  });

  it('trims whitespace from the capability name', () => {
    assert.equal(isCapabilityAvailable(' node ', CAPS), true);
    assert.equal(isCapabilityAvailable(' fish ', CAPS), false);
  });

  it('auth keys are not matchable as capability names', () => {
    const capsNoMcp = { ...CAPS, mcps: [] };
    assert.equal(isCapabilityAvailable('github', capsNoMcp), false);
  });

  it('returns false on empty capabilities', () => {
    const empty: Capabilities = { version: '1', updated: '', shells: [], clis: {}, mcps: [], auth: {} };
    assert.equal(isCapabilityAvailable('node', empty), false);
  });
});
