import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../index.ts';

describe('classifyTask — rule overrides', () => {
  it('keyword hit: architect keyword routes architect slot to opus rule', () => {
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('keyword hit: editor keyword routes editor slot to sonnet (codex disabled until worker wired)', () => {
    const result = classifyTask({
      title: 'refactor the queue module',
      body: 'rename exports and clean up boilerplate',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.editor.provider, 'claude');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('multi-rule priority: first matching rule wins', () => {
    // "migration" matches rule 1 (architect/opus), "refactor" matches rule 2 (editor/codex)
    // first match should win → architect slot gets opus override
    const result = classifyTask({
      title: 'migration and refactor',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('fileGlobs: .sql reference triggers SQL rule and overrides architect to opus', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('fileGlobs: components/ reference triggers UI rule and overrides editor to sonnet', () => {
    const result = classifyTask({
      title: 'tweak components/Button styling',
      body: 'no logic changes',
      labels: ['auto:ship'],
    });
    assert.equal(result.editor.provider, 'claude');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });
});

describe('classifyTask — dynamic scorer', () => {
  it('simple task with no signals → haiku tier on architect', () => {
    const result = classifyTask({
      title: 'fix typo in readme',
      body: 'one character',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
  });

  it('medium-weight keyword → sonnet tier on architect', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('high-weight keyword not in rules → opus tier on architect', () => {
    // "stripe" + "payment" are high-weight scorer keywords but not in any rule's
    // keyword list (and "oauth" would substring-match "auth" in rule 1), so the
    // scorer (not a rule override) decides the model here.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('editor is one tier below architect', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('editor never goes below haiku', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.editor.model, 'claude-haiku-4-5-20251001');
  });

  it('priority:high bumps tier up one', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'priority:high'],
    });
    // sonnet bumped to opus
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('chore label bumps tier down one', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'chore'],
    });
    // sonnet bumped to haiku
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
  });

  it('reviewer mirrors architect tier and stays on claude', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.reviewer.provider, 'claude');
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
  });
});

describe('classifyTask — labels & verify', () => {
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

  it('rule-driven verify (.tsx/components) unions with label hints', () => {
    // components/Foo.tsx matches the UI rule which specifies
    // verify: ["typecheck","lint","test","playwright"]. The rule's verify must
    // be unioned with the label-driven default, not discarded.
    const result = classifyTask({
      title: 'tweak components/Foo.tsx styling',
      body: '',
      labels: ['auto:ship'],
    });
    assert.ok(
      result.verify.includes('playwright'),
      `expected verify to include 'playwright', got ${JSON.stringify(result.verify)}`,
    );
  });
});
