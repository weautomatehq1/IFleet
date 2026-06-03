import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../index.ts';

describe('classifyTask — rule overrides', () => {
  it('keyword hit routes architect to opus (canonical §3.2 override #1: auth/security category)', () => {
    // Post-M4.5 / ADR-0004: the Phase B Opus cap is removed. "auth" + "security"
    // are HIGH_KEYWORDS (score 6 → opus tier); canonical §3.2 override #1
    // says category ∈ {security, auth, payments, migration} → Opus regardless.
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'verify:typecheck', 'verify:lint', 'verify:test'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
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

  it('multi-rule priority: first matching rule wins; migration routes architect to opus (canonical override #1)', () => {
    // "migration" matches rule 1 (architect/opus), "refactor" matches rule 2 (editor/codex).
    // First match wins. Post-M4.5: no Opus cap; migration category triggers
    // canonical §3.2 override #1 unconditionally.
    const result = classifyTask({
      title: 'migration and refactor',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('fileGlobs: .sql reference matches SQL rule; architect routes to opus (migration category, canonical override #1)', () => {
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
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

  it('high-weight keyword routes architect to opus (payments category, canonical override #1)', () => {
    // "stripe" + "payment" are HIGH_KEYWORDS (score 6 → opus tier). Pre-Phase C
    // the Opus cap forced this back to sonnet; post-M4.5 / ADR-0004 the
    // canonical correctness-first routing lets payments-category findings
    // reach Opus directly per §3.2 override #1.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-opus-4-7');
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

  it('priority:high bumps tier; sonnet → opus is allowed (no cap post-M4.5)', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'priority:high'],
    });
    // "feature" is a MEDIUM_KEYWORD (score 1 → sonnet). priority:high bumps
    // the tier up one. Pre-Phase C the Opus cap demoted this back to sonnet;
    // post-M4.5 the canonical correctness-first policy lets priority:high
    // reach opus when the operator asked for it.
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('priority:high + complexity:high promotes architect to opus', () => {
    const result = classifyTask({
      title: 'add a new feature toggle',
      body: '',
      labels: ['auto:ship', 'priority:high', 'complexity:high'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('complexity:low does NOT demote a payments-category override (canonical §3.2: override #1 wins regardless of severity)', () => {
    // Pre-Phase C: complexity:low could demote any opus back to sonnet via the
    // cap. Post-M4.5 / ADR-0004: canonical §3.2 override #1 wins "regardless
    // of severity" — a payments-category finding cannot be downshifted by a
    // severity hint. complexity:low is parsed but has no demoting effect when
    // a category override fires.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:low'],
    });
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

describe('classifyTask — rule override + complexity hint (post-M4.5 canonical alignment)', () => {
  it('SQL rule (architect→opus) + complexity:low: architect stays opus (migration override #1 wins)', () => {
    // Pre-Phase C this test asserted the cap demoted to sonnet. Post-M4.5 /
    // ADR-0004: canonical §3.2 override #1 (migration category → Opus regardless
    // of severity) wins; complexity:low is parsed but cannot demote.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'complexity:low'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('SQL rule (architect→opus) with NO complexity label routes architect to opus', () => {
    // Pre-Phase C: cap demoted to sonnet. Post-M4.5: canonical correctness-
    // first routing honors the rule directly.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.provider, 'claude');
    assert.equal(result.architect.model, 'claude-opus-4-7');
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
    // .sql rule maps architect→opus. Post-M4.5: no cap, architect stays opus,
    // reviewer must mirror at opus.
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
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
  });

  it('rule-override (architect role) with complexity:low keeps reviewer >= architect (migration override #1 wins)', () => {
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
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
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

  it('explicit complexity:low does NOT demote a payments-category override (reviewer mirrors at opus)', () => {
    // Post-M4.5: canonical §3.2 override #1 wins regardless of severity hint.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'complexity:low'],
    });
    assertReviewerGteArchitect(
      result.architect.model,
      result.reviewer.model,
      'complexity:low + payments override',
    );
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.reviewer.model, 'claude-opus-4-7');
  });
});

describe('classifyTask — plan-reviewer floor derivation (M2, upgrades/02-plan-reviewer.md)', () => {
  // Floor table (canonical §2.5 — "Haiku or Sonnet" for plan-reviewer):
  //   architect=opus   → planReviewer=sonnet (cheap pre-gate floor)
  //   architect=sonnet → planReviewer=haiku  (default cheap tier)
  //   architect=haiku  → planReviewer=haiku  (already at floor)
  // PR #132 fixed F-002 (haiku-floor classifier bug); these tests pin the
  // contract so a future refactor cannot silently regress it.

  it('plan-reviewer floor — complexity:high (label) forces architect Opus → planReviewer Sonnet', () => {
    // complexity:high alone is sufficient to promote architect to opus — no
    // HIGH_KEYWORDS in the title. Pins the label-driven promotion path.
    const result = classifyTask({
      title: 'do a thing',
      body: '',
      labels: ['auto:ship', 'complexity:high'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.ok(result.planReviewer, 'planReviewer must be set on every decision');
    assert.equal(result.planReviewer?.model, 'claude-sonnet-4-6');
    assert.equal(result.planReviewer?.provider, 'claude');
  });

  it('HIGH_KEYWORDS alone (without complexity:high) → architect Opus, planReviewer Sonnet (canonical override #1)', () => {
    // Pre-Phase C this asserted cap-driven sonnet/haiku. Post-M4.5 / ADR-0004:
    // HIGH_KEYWORDS hit ("stripe" + "payment" → score 6) routes architect to
    // opus per canonical §3.2 override #1; plan-reviewer floors at sonnet
    // because architect=opus.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.ok(result.planReviewer, 'planReviewer must be set on every decision');
    assert.equal(result.planReviewer?.model, 'claude-sonnet-4-6');
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
