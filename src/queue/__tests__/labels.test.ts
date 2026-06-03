import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Octokit } from '@octokit/rest';
import {
  REQUIRED_LABELS,
  ensureLabels,
  parseLabels,
  parseRequiredCapabilities,
} from '../labels.js';

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

  // M4.7 (ADR-0004 §Known-Limitations item 2): explicit category/severity
  // label parsing for canonical §3.2 overrides #1 and #2.
  it('parses category:security and category:AUTH (case insensitive)', () => {
    assert.equal(parseLabels(['category:security']).category, 'security');
    assert.equal(parseLabels(['category:AUTH']).category, 'auth');
    assert.equal(parseLabels(['Category:Payments']).category, 'payments');
    assert.equal(parseLabels(['category:migration']).category, 'migration');
  });

  it('parses severity:critical and severity:Cosmetic (case insensitive)', () => {
    assert.equal(parseLabels(['severity:critical']).severity, 'critical');
    assert.equal(parseLabels(['severity:Cosmetic']).severity, 'cosmetic');
    assert.equal(parseLabels(['Severity:IMPORTANT']).severity, 'important');
  });

  it('ignores category:unknown gracefully (no throw, no value set)', () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const hints = parseLabels(['category:foo']);
      assert.equal(hints.category, undefined);
      assert.ok(warned, 'expected a dev-log warning for unknown category value');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('ignores severity:unknown gracefully (no throw, no value set)', () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const hints = parseLabels(['severity:bogus']);
      assert.equal(hints.severity, undefined);
      assert.ok(warned, 'expected a dev-log warning for unknown severity value');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('multiple category labels: first wins', () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const hints = parseLabels(['category:security', 'category:payments']);
      assert.equal(hints.category, 'security');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('category and severity coexist with existing complexity/priority labels', () => {
    const hints = parseLabels([
      'category:auth',
      'severity:critical',
      'complexity:high',
      'priority:high',
      'auto:ship',
    ]);
    assert.equal(hints.category, 'auth');
    assert.equal(hints.severity, 'critical');
    assert.equal(hints.priority, 'high');
    // complexity:* is parsed by classifier.parseComplexity, not labels.ts;
    // assertion here just confirms the new fields don't clobber existing ones.
    assert.equal(hints.autonomy, 'auto');
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

interface FakeCreateLabelParams {
  owner: string;
  repo: string;
  name: string;
  color: string;
  description?: string;
}

interface LabelFixture {
  existing: Set<string>;
  created: FakeCreateLabelParams[];
}

function makeFixture(existing: string[] = []): {
  fixture: LabelFixture;
  octokit: Octokit;
} {
  const fixture: LabelFixture = { existing: new Set(existing), created: [] };
  const octokit = {
    issues: {
      createLabel: async (p: FakeCreateLabelParams) => {
        if (fixture.existing.has(p.name)) {
          const err = new Error('already_exists') as Error & {
            status: number;
            response: { data: { errors: Array<{ code: string }> } };
          };
          err.status = 422;
          err.response = { data: { errors: [{ code: 'already_exists' }] } };
          throw err;
        }
        fixture.existing.add(p.name);
        fixture.created.push(p);
      },
    },
  } as unknown as Octokit;
  return { fixture, octokit };
}

describe('ensureLabels', () => {
  const REPO = { owner: 'weautomatehq1', name: 'IFleet' } as const;

  it('creates all required labels when none exist', async () => {
    const { fixture, octokit } = makeFixture([]);
    const result = await ensureLabels(octokit, REPO);
    assert.equal(result.created.length, REQUIRED_LABELS.length);
    assert.deepEqual(result.existed, []);
    for (const spec of REQUIRED_LABELS) {
      assert.ok(fixture.existing.has(spec.name), `expected ${spec.name} to be created`);
    }
  });

  it('is idempotent when all labels already exist', async () => {
    const allNames = REQUIRED_LABELS.map((l) => l.name);
    const { fixture, octokit } = makeFixture(allNames);
    const result = await ensureLabels(octokit, REPO);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.existed, allNames);
    assert.equal(fixture.created.length, 0);
  });

  it('creates only missing labels and skips existing ones', async () => {
    const present = [REQUIRED_LABELS[0]!.name, REQUIRED_LABELS[2]!.name];
    const { fixture, octokit } = makeFixture(present);
    const result = await ensureLabels(octokit, REPO);
    assert.equal(result.existed.length, 2);
    assert.equal(
      result.created.length,
      REQUIRED_LABELS.length - 2,
      'should create only the missing ones',
    );
    for (const created of fixture.created) {
      assert.ok(!present.includes(created.name), 'must not re-create existing labels');
    }
  });

  it('propagates non-422 errors', async () => {
    const octokit = {
      issues: {
        createLabel: async () => {
          const err = new Error('boom') as Error & { status: number };
          err.status = 500;
          throw err;
        },
      },
    } as unknown as Octokit;
    await assert.rejects(() => ensureLabels(octokit, REPO), /boom/);
  });

  it('treats bare 422 (no response body) as already-exists', async () => {
    const octokit = {
      issues: {
        createLabel: async () => {
          const err = new Error('exists') as Error & { status: number };
          err.status = 422;
          throw err;
        },
      },
    } as unknown as Octokit;
    const result = await ensureLabels(octokit, REPO);
    assert.equal(result.created.length, 0);
    assert.equal(result.existed.length, REQUIRED_LABELS.length);
  });
});
