import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../index.ts';

describe('classifyTask — rule overrides', () => {
  it('keyword hit without complexity:high stays on sonnet (architect opus cap)', () => {
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.architect.provider, 'claude');
  });

  it('keyword hit with complexity:high routes architect to opus', () => {
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'complexity:high'],
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

  it('multi-rule priority: first matching rule wins (capped to sonnet without complexity:high)', () => {
    // "migration" matches rule 1 (architect/opus), "refactor" matches rule 2 (editor/codex)
    // first match still wins, but the architect opus cap forces sonnet.
    const result = classifyTask({
      title: 'migration and refactor',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.architect.provider, 'claude');
  });

  it('fileGlobs: .sql reference matches SQL rule but architect stays on sonnet (cap)', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.architect.provider, 'claude');
  });

  it('fileGlobs: .sql with complexity:high promotes architect to opus', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'complexity:high'],
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

  it('high-weight keyword without complexity:high caps architect at sonnet', () => {
    // "stripe" + "payment" are high-weight scorer keywords. Pre-Phase B this
    // produced opus; the architect cap now keeps it at sonnet unless the
    // operator explicitly labels the issue `complexity:high`.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('high-weight keyword + complexity:high promotes architect to opus', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:high'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('editor is one tier below architect (with complexity:high → opus/sonnet)', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:high'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('editor is floored at sonnet even when architect is haiku', () => {
    // Pre-fix this returned haiku/haiku, but haiku in `claude -p` print mode
    // reliably returns ok=true while making zero file edits, which then burns
    // reviewer tokens on an empty diff. The editor tier is now floored at
    // sonnet regardless of how low the architect tier goes.
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('editor is sonnet when architect is sonnet (one tier below would be haiku, floor applies)', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('priority:high bumps tier up one but is still capped at sonnet for architect', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'priority:high'],
    });
    // pre-Phase B this bumped sonnet → opus; the architect cap holds it at sonnet
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('priority:high + complexity:high promotes architect to opus', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'priority:high', 'complexity:high'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('complexity:low forces sonnet even when scorer/rule wants opus', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:low'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
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
      labels: ['auto:ship', 'complexity:high'],
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

describe('classifyTask — architect cap with rule override (issue #43)', () => {
  it('SQL rule (architect→opus) + complexity:low caps architect to sonnet', () => {
    // The .sql fileGlob rule maps architect to claude-opus-4-7. The
    // complexity:low label must keep the architect at sonnet, not opus.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'complexity:low'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('SQL rule (architect→opus) with NO complexity label caps architect to sonnet', () => {
    // Default cap: any opus that did not come from explicit complexity:high
    // (whether from scorer or rule) must drop back to sonnet. Distinct from
    // the complexity:low case above — here no complexity label is present.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });
});

describe('classifyTask — reviewer >= architect invariant (issue #44)', () => {
  const TIER_RANK: Record<string, number> = {
    'claude-haiku-4-5-20251001': 0,
    'claude-sonnet-4-6': 1,
    'claude-opus-4-7': 2,
  };

  function assertReviewerGteArchitect(
    architectModel: string,
    reviewerModel: string,
    ctx: string,
  ) {
    const a = TIER_RANK[architectModel];
    const r = TIER_RANK[reviewerModel];
    assert.ok(
      a !== undefined && r !== undefined,
      `${ctx}: unknown model (architect=${architectModel}, reviewer=${reviewerModel})`,
    );
    assert.ok(
      r >= a,
      `${ctx}: reviewer (${reviewerModel}) must be >= architect (${architectModel})`,
    );
  }

  it('scorer-only path (no rule match, no complexity label) keeps reviewer >= architect', () => {
    // "fix typo" has no rule match and no complexity label → haiku/haiku.
    const result = classifyTask({
      title: 'fix typo in readme',
      body: 'one character',
      labels: ['auto:ship'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'scorer-only',
    );
  });

  it('rule-override (architect role, no complexity label) keeps reviewer >= architect', () => {
    // .sql rule maps architect→opus; cap demotes to sonnet. Reviewer must
    // match the final architect tier, not the pre-rule baseTier.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'rule-override (no complexity)',
    );
    assert.equal(result.reviewer.model, 'claude-sonnet-4-6');
  });

  it('rule-override (architect role) with complexity:low keeps reviewer >= architect', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'complexity:low'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'rule-override + complexity:low',
    );
    assert.equal(result.reviewer.model, 'claude-sonnet-4-6');
  });

  it('rule-override (architect role) with complexity:high keeps reviewer >= architect', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'complexity:high'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'rule-override + complexity:high',
    );
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
  });

  it('explicit complexity:high (scorer path) keeps reviewer >= architect', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:high'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'complexity:high',
    );
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
  });

  it('explicit complexity:low keeps reviewer >= architect', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:low'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'complexity:low',
    );
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.reviewer.model, 'claude-sonnet-4-6');
  });
});

describe('classifyTask — plan-reviewer floor derivation (M2, upgrades/02-plan-reviewer.md)', () => {
  // Floor table from docs/elevation/upgrades/02-plan-reviewer.md:
  //   architect=opus   → planReviewer=sonnet (opus cap protects rate limit)
  //   architect=sonnet → planReviewer=haiku  (default cheap tier)
  //   architect=haiku  → planReviewer=haiku  (already at floor)
  // PR #132 fixed F-002 (haiku-floor classifier bug); these tests pin the
  // contract so a future refactor cannot silently regress it.

  it('plan-reviewer floor — architect Opus → Sonnet', () => {
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:high'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.ok(result.planReviewer, 'planReviewer must be set on every decision');
    assert.equal(result.planReviewer?.model, 'claude-sonnet-4-6');
    assert.equal(result.planReviewer?.provider, 'claude');
  });

  it('plan-reviewer floor — architect Sonnet → Haiku', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.ok(result.planReviewer, 'planReviewer must be set on every decision');
    assert.equal(result.planReviewer?.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.planReviewer?.provider, 'claude');
  });

  it('plan-reviewer floor — architect Haiku → Haiku', () => {
    const result = classifyTask({
      title: 'fix typo in readme',
      body: 'one character',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
    assert.ok(result.planReviewer, 'planReviewer must be set on every decision');
    assert.equal(result.planReviewer?.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.planReviewer?.provider, 'claude');
  });
});
