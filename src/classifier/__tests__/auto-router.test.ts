import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_FALLBACK,
  autoRouteMode,
  buildRouterPrompt,
  clearAutoRouterCache,
  isBelowConfidenceThreshold,
  parseRouterDecision,
  type HaikuCall,
} from '../auto-router.ts';

beforeEach(() => clearAutoRouterCache());

const baseInput = {
  title: 't',
  body: 'b',
  labels: [] as readonly string[],
};

describe('auto-router — kill switch', () => {
  it('returns the standard fallback when AUTO_ROUTER_DISABLED=1', async () => {
    const calls: string[] = [];
    const haiku: HaikuCall = async (p) => {
      calls.push(p);
      return '{"mode":"ralph","risk":"low","confidence":1}';
    };
    const got = await autoRouteMode(baseInput, {
      env: { AUTO_ROUTER_DISABLED: '1' },
      haikuCall: haiku,
    });
    assert.equal(got.mode, 'standard');
    assert.equal(got.fromModel, false);
    assert.equal(calls.length, 0, 'haiku must NOT be called when kill switch is on');
    assert.match(got.reason, /disabled/i);
  });
});

describe('auto-router — cache', () => {
  it('caches the decision per brief hash so retries do not re-call Haiku', async () => {
    let calls = 0;
    const haiku: HaikuCall = async () => {
      calls++;
      return '{"mode":"ulw","risk":"low","confidence":0.9}';
    };
    const a = await autoRouteMode(baseInput, { haikuCall: haiku });
    const b = await autoRouteMode(baseInput, { haikuCall: haiku });
    assert.equal(calls, 1, 'cache hit should skip the second haiku call');
    assert.deepEqual(a, b);
  });

  it('distinct input → distinct cache entry', async () => {
    let calls = 0;
    const haiku: HaikuCall = async () => {
      calls++;
      return '{"mode":"tdd","risk":"med","confidence":0.8}';
    };
    await autoRouteMode({ ...baseInput, title: 'one' }, { haikuCall: haiku });
    await autoRouteMode({ ...baseInput, title: 'two' }, { haikuCall: haiku });
    assert.equal(calls, 2);
  });
});

describe('auto-router — parse', () => {
  it('parses a clean JSON response', () => {
    const got = parseRouterDecision(
      '{"mode":"ralph","risk":"high","confidence":0.85,"reason":"retry-heavy"}',
      [],
    );
    assert.equal(got.mode, 'ralph');
    assert.equal(got.risk, 'high');
    assert.equal(got.confidence, 0.85);
    assert.equal(got.fromModel, true);
  });

  it('extracts JSON from prose-wrapped output', () => {
    const got = parseRouterDecision(
      'Here is my answer: {"mode":"tdd","risk":"med","confidence":0.7} done.',
      [],
    );
    assert.equal(got.mode, 'tdd');
  });

  it('clamps confidence to [0,1]', () => {
    const high = parseRouterDecision('{"mode":"ralph","risk":"low","confidence":2.5}', []);
    assert.equal(high.confidence, 1);
    const neg = parseRouterDecision('{"mode":"ralph","risk":"low","confidence":-1}', []);
    assert.equal(neg.confidence, 0);
  });

  it('falls back when JSON is malformed', () => {
    const got = parseRouterDecision('not json at all', []);
    assert.equal(got.mode, STANDARD_FALLBACK.mode);
    assert.equal(got.fromModel, false);
  });

  it('falls back when mode is unknown', () => {
    const got = parseRouterDecision('{"mode":"rampage","risk":"low","confidence":0.9}', []);
    assert.equal(got.mode, 'standard');
  });

  it('upgrades risk from "low" to "med" when repo flagged the path as high-risk', () => {
    const got = parseRouterDecision(
      '{"mode":"ralph","risk":"low","confidence":0.9}',
      ['migration'],
    );
    assert.equal(got.risk, 'med');
  });
});

describe('auto-router — flow', () => {
  it('passes a fallback through when Haiku throws', async () => {
    const haiku: HaikuCall = async () => {
      throw new Error('timeout');
    };
    const got = await autoRouteMode(baseInput, { haikuCall: haiku });
    assert.equal(got.mode, 'standard');
    assert.equal(got.fromModel, false);
    assert.match(got.reason, /timeout/);
  });

  it('low-confidence is detected by isBelowConfidenceThreshold', () => {
    const low = { ...STANDARD_FALLBACK, confidence: 0.3 };
    const high = { ...STANDARD_FALLBACK, confidence: 0.9, fromModel: true };
    assert.equal(isBelowConfidenceThreshold(low), true);
    assert.equal(isBelowConfidenceThreshold(high), false);
  });

  it('build prompt includes the title, labels, and brief', () => {
    const prompt = buildRouterPrompt({
      title: 'wire up stripe',
      body: 'add billing',
      labels: ['priority:high'],
      learnings: '',
      riskFlags: ['stripe'],
    });
    assert.match(prompt, /wire up stripe/);
    assert.match(prompt, /priority:high/);
    assert.match(prompt, /add billing/);
    assert.match(prompt, /stripe/);
  });
});
