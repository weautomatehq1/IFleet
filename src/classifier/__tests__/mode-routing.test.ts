import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, classifyTaskAsync } from '../index.ts';
import { clearAutoRouterCache, type HaikuCall } from '../auto-router.ts';

beforeEach(() => clearAutoRouterCache());

describe('classifyTask — mode detection (sync, AC#1)', () => {
  it('mode:ralph label sets RoutingDecision.mode = ralph', () => {
    const result = classifyTask({
      title: 'refactor queue',
      body: '',
      labels: ['auto:ship', 'mode:ralph'],
    });
    assert.equal(result.mode, 'ralph');
  });

  it('mode header inside the body sets RoutingDecision.mode', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: 'mode: tdd\n\nplease ship tests first',
      labels: ['auto:ship'],
    });
    assert.equal(result.mode, 'tdd');
  });

  it('absent mode → RoutingDecision.mode is undefined', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: 'one char',
      labels: ['auto:ship'],
    });
    assert.equal(result.mode, undefined);
  });

  it('explicit task.mode beats both label and body header', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: 'mode: tdd',
      labels: ['mode:ulw'],
      mode: 'deslop',
    });
    assert.equal(result.mode, 'deslop');
  });
});

describe('classifyTask — mode overrides from config/routing.json', () => {
  it('deslop mode overrides architect down to haiku', () => {
    const result = classifyTask({
      title: 'clean generated code',
      body: '',
      labels: ['auto:ship', 'mode:deslop'],
    });
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('ralph mode keeps architect at sonnet (override floor)', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'mode:ralph'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('tdd mode adds verify kinds without losing the label-derived ones', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'mode:tdd', 'verify:typecheck'],
    });
    assert.ok(result.verify.includes('typecheck'));
    assert.ok(result.verify.includes('test'));
  });

  it('standard mode is a no-op (architect/editor follow the rule/cap pipeline)', () => {
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'mode:standard'],
    });
    assert.equal(result.mode, 'standard');
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
  });
});

describe('classifyTaskAsync — auto-router integration (AC#2, AC#3)', () => {
  it('explicit label override beats the auto-router (AC#1)', async () => {
    let routerCalls = 0;
    const haiku: HaikuCall = async () => {
      routerCalls++;
      return '{"mode":"deslop","risk":"low","confidence":0.95}';
    };
    const result = await classifyTaskAsync(
      { title: 'fix typo', body: '', labels: ['auto:ship', 'mode:ralph'] },
      { autoRouter: { haikuCall: haiku } },
    );
    assert.equal(result.mode, 'ralph');
    assert.equal(routerCalls, 0, 'auto-router must not be invoked when an explicit mode is present');
  });

  it('no tag → auto-router decision is applied (AC#2)', async () => {
    const haiku: HaikuCall = async () =>
      '{"mode":"ulw","risk":"med","confidence":0.85}';
    const result = await classifyTaskAsync(
      { title: 'multi-file refactor', body: '', labels: ['auto:ship'] },
      { autoRouter: { haikuCall: haiku } },
    );
    assert.equal(result.mode, 'ulw');
  });

  it('low-confidence → falls back to standard and fires onLowConfidence (AC#3)', async () => {
    const haiku: HaikuCall = async () =>
      '{"mode":"ralph","risk":"low","confidence":0.4}';
    const notified: number[] = [];
    const result = await classifyTaskAsync(
      { title: 'ambiguous task', body: '', labels: ['auto:ship'] },
      {
        autoRouter: { haikuCall: haiku },
        onLowConfidence: (d) => {
          notified.push(d.confidence);
        },
      },
    );
    assert.equal(result.mode, undefined, 'low-confidence does not set a mode');
    assert.deepEqual(notified, [0.4]);
  });

  it('low-confidence handler errors must NOT break routing', async () => {
    const haiku: HaikuCall = async () =>
      '{"mode":"ralph","risk":"low","confidence":0.4}';
    const result = await classifyTaskAsync(
      { title: 't', body: '', labels: ['auto:ship'] },
      {
        autoRouter: { haikuCall: haiku },
        onLowConfidence: () => {
          throw new Error('observability is down');
        },
      },
    );
    assert.equal(result.mode, undefined);
  });
});
