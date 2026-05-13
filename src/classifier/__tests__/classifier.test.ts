import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../index.ts';

describe('classifyTask', () => {
  it('keyword hit: architect keyword routes architect slot to opus', () => {
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.architect.model, 'opus-4.7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('keyword hit: editor keyword routes editor slot to codex', () => {
    const result = classifyTask({
      title: 'refactor the queue module',
      body: 'rename exports and clean up boilerplate',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.editor.provider, 'codex');
  });

  it('no match: falls back to pipeline defaults', () => {
    const result = classifyTask({
      title: 'add a button to the header',
      body: 'it should say hello',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    // pipeline defaults
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'opus-4.7');
    assert.equal(result.editor.provider, 'codex');
  });

  it('multi-rule priority: first matching rule wins', () => {
    // "migration" matches rule 1 (architect/opus), "refactor" matches rule 2 (editor/codex)
    // first match should win → architect slot gets opus
    const result = classifyTask({
      title: 'migration and refactor',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'opus-4.7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('reviewer uses opposite provider of editor', () => {
    // default editor is codex → reviewer should be claude
    const result = classifyTask({
      title: 'add a feature',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.editor.provider, 'codex');
    assert.equal(result.reviewer.provider, 'claude');
  });

  it('verify comes from labels', () => {
    const result = classifyTask({
      title: 'something',
      body: '',
      labels: ['auto:ship', 'verify:typecheck', 'verify:test'],
    });
    assert.deepEqual(result.verify, ['typecheck', 'test']);
  });

  it('verify defaults to typecheck+lint+test when no verify labels', () => {
    const result = classifyTask({
      title: 'something',
      body: '',
      labels: ['auto:ship'],
    });
    assert.deepEqual(result.verify, ['typecheck', 'lint', 'test']);
  });
});
