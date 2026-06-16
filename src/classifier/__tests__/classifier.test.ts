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

  it('MEDIUM_KEYWORD + complexity:low stays at sonnet (no override, no demotion)', () => {
    // Phase C decision: complexity:low has no demoting effect anywhere in
    // classifier code — neither on category-override Opus (test above) nor
    // on non-override sonnet/haiku paths. Pins canonical §3.2: complexity:low
    // is not an override; the matrix row that matches applies. "feature
    // toggle" scores +1 → sonnet; complexity:low does not push it to haiku.
    // If a future ADR wants complexity:low to bump non-override tiers down,
    // change this test deliberately rather than letting drift happen silently.
    const result = classifyTask({
      title: 'add a new feature toggle',
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

describe('classifyTask — rule override + complexity hint (issue #43, post-M4.5 canonical alignment)', () => {
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

describe('classifyTask — mode override interaction (M4.6 + M4.8)', () => {
  // Closes ADR-0004 §Known-Limitations items 1 (M4.6 mode override category
  // protection) and 3 (M4.8 reviewer derivation after mode overrides).
  // See src/classifier/index.ts — the `categoryOverrideTriggered` flag plus
  // reviewer-derivation move after the mode-override block.

  it('M4.6 — auth + mode:tdd: architect stays Opus (category override #1 wins over mode demotion)', () => {
    // "auth" + "security" are HIGH_KEYWORDS (category override #1). Rule 1
    // also matches and routes architect to Opus. mode:tdd normally pins
    // architect to Sonnet, but M4.6 blocks the demotion because the category
    // override fired. Editor override from mode:tdd (sonnet) still applies.
    const result = classifyTask({
      title: 'security audit of auth middleware',
      body: 'check the auth flow',
      labels: ['auto:ship', 'mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('M4.6 — stripe + mode:ulw: architect stays Opus (payments category, scorer trigger)', () => {
    // "stripe" + "payment" → HIGH_KEYWORDS score 6 → baseTier=opus → flag
    // triggered via the scorer path (no rule match for stripe). mode:ulw
    // would demote architect to Sonnet; M4.6 blocks the architect demotion.
    const result = classifyTask({
      title: 'wire up stripe payment intents',
      body: '',
      labels: ['auto:ship', 'mode:ulw'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('M4.6 — SQL rule + mode:deslop: architect stays Opus (migration category, rule trigger)', () => {
    // users.sql matches rule 4 (fileGlobs include **/*.sql / migrations/** /
    // supabase/**) which routes architect → Opus. The rule's globs contain
    // category needles (sql / migrations / supabase), so the M4.6 rule
    // trigger fires. mode:deslop would demote architect to Haiku; M4.6
    // blocks it. Editor override (mode:deslop → sonnet) still applies.
    const result = classifyTask({
      title: 'add seed file users.sql to the repo',
      body: 'seed data for local dev',
      labels: ['auto:ship', 'mode:deslop'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('M4.6 negative — non-category mode override still applies (fix typo + mode:tdd → sonnet)', () => {
    // No HIGH_KEYWORDS hit, no rule match → baseTier=haiku → flag NOT set.
    // mode:tdd's architect=sonnet pin therefore applies normally.
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('M4.6 negative — rule match via non-category keyword does NOT set flag (redesign architecture + mode:tdd → sonnet)', () => {
    // Codex review of PR #301 caught this: the original trigger-#2 implementation
    // inspected the matched rule's ENTIRE declared keyword list. Rule 1 mixes
    // architectural-design keywords ("architect", "design") with canonical
    // category keywords ("security", "auth", "migration", "rls", "critical").
    // A title that matches rule 1 via "architect" (substring of "architecture")
    // would flip the flag and block the mode:tdd demotion — even though the
    // task is not in a canonical §3.2 override #1 category. The fix tracks the
    // specific matched keyword and only flips the flag when THAT keyword is a
    // category needle. This test pins the canonical-correct behavior.
    const result = classifyTask({
      title: 'redesign the application architecture',
      body: '',
      labels: ['mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('M4.6 negative — rule match via "design" + mode:deslop → haiku (no category override)', () => {
    // Second Codex-review-suggested test. "component" is a MEDIUM_KEYWORD
    // (score 1 → sonnet baseTier), "design" matches rule 1. Neither signal
    // is a canonical category needle, so mode:deslop's architect=haiku pin
    // must apply unimpeded.
    const result = classifyTask({
      title: 'design a new dashboard component',
      body: '',
      labels: ['mode:deslop'],
    });
    assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
  });

  it('M4.8 — fix typo + mode:ralph: reviewer mirrors final architect (sonnet), not pre-mode haiku', () => {
    // Pre-M4.8: reviewer was derived BEFORE the mode-override block, so
    // architect=haiku → reviewer=haiku, then mode:ralph promoted architect
    // to sonnet — leaving reviewer (haiku) weaker than architect (sonnet)
    // and violating the canonical §2.5 "reviewer not weaker than architect"
    // invariant. Post-M4.8: reviewer is derived from the final architect.
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'mode:ralph'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.reviewer.model, 'claude-sonnet-4-6');
  });

  it('M4.8 — complexity:high + mode:tdd: reviewer tracks demoted architect (sonnet), not pre-mode opus', () => {
    // complexity:high alone does NOT trigger M4.6 (only a HIGH_KEYWORD hit
    // or a category-rule match does). So mode:tdd legitimately demotes the
    // complexity:high-promoted architect from opus to sonnet. Reviewer must
    // track the final architect (sonnet); pre-M4.8 it would have stayed at
    // opus (over-spec'd) because reviewer derivation ran before the demotion.
    const result = classifyTask({
      title: 'do a thing',
      body: '',
      labels: ['auto:ship', 'complexity:high', 'mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    assert.equal(result.reviewer.model, 'claude-sonnet-4-6');
  });

  it('b8e860b0 — MEDIUM_KEYWORD aggregate (score≥3) + mode:tdd: mode demotion is honored (no HIGH_KEYWORD)', () => {
    // 5 MEDIUM_KEYWORDS push rawScore to 5 → baseTier=opus, but no HIGH_KEYWORD
    // present → hasHighKeyword=false → categoryOverrideTriggered stays false →
    // mode:tdd architect demotion to sonnet is honored.
    const result = classifyTask({
      title: 'refactor the feature components in the integration service',
      body: '',
      labels: ['mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });

  it('b8e860b0 — priority:high bumps single MEDIUM_KEYWORD to opus + mode:tdd: mode demotion is honored (no HIGH_KEYWORD)', () => {
    // priority:high bumps sonnet→opus on a single MEDIUM_KEYWORD (refactor),
    // but no HIGH_KEYWORD → hasHighKeyword=false → categoryOverrideTriggered
    // not set → mode:tdd demotion to sonnet applies.
    const result = classifyTask({
      title: 'fix the refactor bug',
      body: '',
      labels: ['priority:high', 'mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
  });
});

describe('classifyTask — category:*/severity:* label overrides (M4.7)', () => {
  // Closes ADR-0004 §Known-Limitations item 2 (M4.7 explicit category/severity
  // label parsing). Before M4.7, canonical §3.2 overrides #1 and #2 were
  // reachable only via the HIGH_KEYWORDS scorer (title/body keyword hits) —
  // an operator who labeled an issue `category:security` without putting
  // "security" or "auth" in the title got no Opus promotion. Now the labels
  // are explicit override sources, on equal footing with the scorer path.
  // See src/queue/labels.ts (parser) and src/classifier/index.ts (wiring).

  it('M4.7 — category:security label routes architect to Opus (no HIGH_KEYWORD in title needed)', () => {
    // Title carries no HIGH_KEYWORDS — scorer alone would land at haiku.
    // The category:security label is a direct canonical §3.2 override #1 signal.
    const result = classifyTask({
      title: 'fix some thing',
      body: '',
      labels: ['auto:ship', 'category:security'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.architect.provider, 'claude');
  });

  it('M4.7 — category:payments label routes architect to Opus', () => {
    const result = classifyTask({
      title: 'fix some thing',
      body: '',
      labels: ['auto:ship', 'category:payments'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('M4.7 — severity:critical label routes architect to Opus regardless of category', () => {
    // No HIGH_KEYWORDS, no category label — only severity:critical, which is
    // canonical §3.2 override #2 (CRITICAL → Opus regardless of category).
    const result = classifyTask({
      title: 'tweak the layout',
      body: '',
      labels: ['auto:ship', 'severity:critical'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
  });

  it('M4.7 — category:auth + mode:tdd: architect stays Opus (M4.6 interaction)', () => {
    // Integration test with T2's M4.6 work: the label-driven category trigger
    // sets `categoryOverrideTriggered`, which makes the mode:tdd architect
    // demotion (sonnet) refuse to apply. Editor stays at the Sonnet pin from
    // mode:tdd (which is also the editor floor — no observable difference).
    const result = classifyTask({
      title: 'fix some thing',
      body: '',
      labels: ['auto:ship', 'category:auth', 'mode:tdd'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
    assert.equal(result.editor.model, 'claude-sonnet-4-6');
  });

  it('M4.7 — category:unknown is ignored (no override fires)', () => {
    // Suppress dev-log warning during assertion.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // No HIGH_KEYWORDS, unknown category label → falls through to scorer
      // (haiku). The unknown value must not throw, must not silently route to
      // Opus, and must produce no flag flip.
      const result = classifyTask({
        title: 'fix some thing',
        body: '',
        labels: ['auto:ship', 'category:foo'],
      });
      assert.equal(result.architect.model, 'claude-haiku-4-5-20251001');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('M4.7 — category:security + scorer haiku-tier still routes Opus (label beats scorer)', () => {
    // Title scores 0 — scorer alone would land at haiku. category:security
    // label promotes architect to Opus directly. Confirms the label override
    // is independent of the scorer and beats a low base tier.
    const result = classifyTask({
      title: 'fix typo',
      body: '',
      labels: ['auto:ship', 'category:security'],
    });
    assert.equal(result.architect.model, 'claude-opus-4-7');
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

describe('classifyTask — M4.6 mode×category matrix (Opus floor + warn observability)', () => {
  // Canonical §3.2 override #1 says category ∈ {security, auth, payments,
  // migration} → Opus regardless of severity. M4.6 extends that to
  // "regardless of mode": when the HIGH_KEYWORDS scorer (or a category rule
  // match) puts architect at Opus, a mode override MUST NOT demote the
  // architect below Opus. This 4×4 matrix pins the contract end-to-end:
  // every (mode, category) pair must keep architect=Opus AND emit the
  // documented warn-level suppression so the precedence decision is visible
  // in operator logs.
  //
  // Modes: tdd, ulw, ralph, deslop — every mode in routing.json whose
  // architect pin is below Opus (i.e. would demote). 'standard' is omitted
  // because its override block is empty {} — there is nothing to suppress.
  //
  // Category triggers: one title per canonical category that hits the
  // HIGH_KEYWORDS scorer. 'security' / 'auth' / 'migration' also match
  // rule 1 (architect→Opus). 'payments' is covered via 'stripe' + 'payment'
  // — both HIGH_KEYWORDS but no rule pins payments specifically; this
  // exercises the scorer-only trigger path. 'rls' / 'oauth' / 'encryption'
  // / 'supabase' are HIGH_KEYWORDS too but are not in the canonical category
  // override list, so they are out of scope for this matrix.

  type ModeName = 'tdd' | 'ulw' | 'ralph' | 'deslop';
  const MODES: ModeName[] = ['tdd', 'ulw', 'ralph', 'deslop'];

  const CATEGORIES: ReadonlyArray<{ name: string; title: string }> = [
    { name: 'security', title: 'security audit of the api boundary' },
    { name: 'auth', title: 'fix auth middleware regression' },
    { name: 'payments', title: 'wire up stripe payment intents' },
    { name: 'migration', title: 'plan the migration to multi-tenant schema' },
  ];

  function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    try {
      const result = fn();
      return { result, warnings };
    } finally {
      console.warn = originalWarn;
    }
  }

  for (const mode of MODES) {
    for (const { name, title } of CATEGORIES) {
      it(`mode:${mode} × ${name}: architect stays Opus and suppression warn is emitted`, () => {
        const { result, warnings } = captureWarn(() =>
          classifyTask({
            title,
            body: '',
            labels: ['auto:ship', `mode:${mode}`],
          }),
        );
        assert.equal(
          result.architect.model,
          'claude-opus-4-7',
          `mode:${mode} × ${name}: architect must remain claude-opus-4-7`,
        );
        const suppression = warnings.find(
          (w) =>
            w.includes(`mode '${mode}'`) &&
            w.includes('Opus floor') &&
            w.includes('§3.2 override #1') &&
            w.includes('suppressed'),
        );
        assert.ok(
          suppression,
          `mode:${mode} × ${name}: expected suppression warn citing canonical §3.2 override #1; got ${JSON.stringify(warnings)}`,
        );
      });
    }
  }

  it('baseline — mode:tdd without HIGH_KEYWORDS still downshifts architect to Sonnet (no suppression warn)', () => {
    // Confirms M4.6 only fires when the high-keyword path demands Opus.
    // 'fix typo' carries no HIGH_KEYWORDS and no rule match → baseTier=haiku
    // → mode:tdd's architect=sonnet pin applies normally with NO warn.
    const { result, warnings } = captureWarn(() =>
      classifyTask({
        title: 'fix typo',
        body: '',
        labels: ['auto:ship', 'mode:tdd'],
      }),
    );
    assert.equal(result.architect.model, 'claude-sonnet-4-6');
    const suppression = warnings.find((w) => w.includes('Opus floor'));
    assert.equal(suppression, undefined, `expected no suppression warn; got ${JSON.stringify(warnings)}`);
  });

  it('baseline — HIGH_KEYWORD ("auth") without mode still routes architect to Opus (no warn — nothing to suppress)', () => {
    // Without a mode override there is no demotion attempt, so no warn fires.
    const { result, warnings } = captureWarn(() =>
      classifyTask({
        title: 'security audit of auth middleware',
        body: '',
        labels: ['auto:ship'],
      }),
    );
    assert.equal(result.architect.model, 'claude-opus-4-7');
    const suppression = warnings.find((w) => w.includes('Opus floor'));
    assert.equal(suppression, undefined, `expected no suppression warn; got ${JSON.stringify(warnings)}`);
  });
});
