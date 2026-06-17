// Tests for the M6 drift-scan cron wiring (scripts/drift-scan-run.ts).
//
// The cron entrypoint is a thin wrapper over `mainWithDeps({ runDriftScan,
// postToDiscord })`. Tests inject both seams and assert:
//   - env gating (DRIFT_SCAN_ENABLED=0, missing IFLEET_KG_DATABASE_URL)
//     short-circuits before any Discord call
//   - empty/3/30-candidate results all produce the right Discord shape
//   - injected runDriftScan throwing KgPostgresUnavailableError-style errors
//     does NOT propagate or hit Discord (fail-open contract)
//   - Discord errors do NOT crash the cron

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { formatMessage, mainWithDeps } from '../drift-scan-run.js';
import type { DriftPrPlan } from '../../src/agents/drift-detector/real-pr.js';
import type {
  DriftCandidate,
  DriftScanResult,
} from '../../src/agents/drift-detector/types.js';

const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Record<string, string | undefined>): void {
  for (const k of Object.keys(env)) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  // Strip any inherited DRIFT_SCAN_* / KG var so each test sets its own state.
  delete process.env.DRIFT_SCAN_ENABLED;
  delete process.env.DRIFT_SCAN_REPOS;
  delete process.env.IFLEET_KG_DATABASE_URL;
  delete process.env.DRIFT_REAL_PR;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function candidate(overrides: Partial<DriftCandidate> = {}): DriftCandidate {
  return {
    symbolKey: 'function:foo',
    name: 'foo',
    kind: 'function',
    driftKind: 'signature_skew',
    groups: [
      { signature: 'function foo(): void', repos: ['weautomatehq1/IFleet'], paths: ['src/a.ts'] },
      { signature: 'function foo(x: number): void', repos: ['weautomatehq1/factory'], paths: ['src/b.ts'] },
    ],
    outlierRepos: ['weautomatehq1/factory'],
    ...overrides,
  };
}

function result(overrides: Partial<DriftScanResult> = {}): DriftScanResult {
  return {
    scannedAt: '2026-06-16T02:00:00.000Z',
    reposScanned: ['weautomatehq1/IFleet', 'weautomatehq1/factory'],
    symbolsCompared: 0,
    candidates: [],
    summary: { signature_skew: 0, rename_or_deletion: 0, orphan_reference: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatMessage
// ---------------------------------------------------------------------------

describe('formatMessage', () => {
  it('empty result renders the "clean across N repos" message', () => {
    const msg = formatMessage(result({ candidates: [] }));
    expect(msg).toContain('**Drift scan — 2026-06-16**');
    expect(msg).toContain('Drift scan — 2026-06-16: clean across 2 repos.');
  });

  it('3 candidates render 3 bullet lines under the header', () => {
    const cands: DriftCandidate[] = [
      candidate({ name: 'a', outlierRepos: ['weautomatehq1/factory'] }),
      candidate({
        name: 'b',
        driftKind: 'rename_or_deletion',
        outlierRepos: ['weautomatehq1/IFleet'],
      }),
      candidate({ name: 'c', outlierRepos: ['weautomatehq1/factory', 'weautomatehq1/IFleet'] }),
    ];
    const msg = formatMessage(result({ candidates: cands }));
    const lines = msg.split('\n');
    expect(lines[0]).toBe('**Drift scan — 2026-06-16**');
    // header + 3 bullets = 4 lines, no overflow line
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('- weautomatehq1/factory: signature_skew on a (severity=1)');
    expect(lines[2]).toBe('- weautomatehq1/IFleet: rename_or_deletion on b (severity=1)');
    expect(lines[3]).toBe(
      '- weautomatehq1/factory,weautomatehq1/IFleet: signature_skew on c (severity=2)',
    );
    expect(msg).not.toContain('more');
  });

  it('30 candidates render 25 lines + "… and 5 more"', () => {
    const cands: DriftCandidate[] = Array.from({ length: 30 }, (_, i) =>
      candidate({
        name: `sym${i}`,
        symbolKey: `function:sym${i}`,
        outlierRepos: ['weautomatehq1/factory'],
      }),
    );
    const msg = formatMessage(result({ candidates: cands }));
    const lines = msg.split('\n');
    // header + 25 bullets + overflow = 27 lines
    expect(lines).toHaveLength(27);
    expect(lines[0]).toBe('**Drift scan — 2026-06-16**');
    expect(lines[1]).toBe(
      '- weautomatehq1/factory: signature_skew on sym0 (severity=1)',
    );
    expect(lines[25]).toBe(
      '- weautomatehq1/factory: signature_skew on sym24 (severity=1)',
    );
    expect(lines[26]).toBe('… and 5 more');
  });
});

// ---------------------------------------------------------------------------
// mainWithDeps — env gating
// ---------------------------------------------------------------------------

describe('mainWithDeps — env gating', () => {
  it('DRIFT_SCAN_ENABLED unset → no scan, no Discord call, exit 0', async () => {
    const runDriftScan = vi.fn();
    const postToDiscord = vi.fn();
    const code = await mainWithDeps({ runDriftScan, postToDiscord });
    expect(code).toBe(0);
    expect(runDriftScan).not.toHaveBeenCalled();
    expect(postToDiscord).not.toHaveBeenCalled();
  });

  it('DRIFT_SCAN_ENABLED=0 → no scan, no Discord call', async () => {
    setEnv({ DRIFT_SCAN_ENABLED: '0', IFLEET_KG_DATABASE_URL: 'postgres://x' });
    const runDriftScan = vi.fn();
    const postToDiscord = vi.fn();
    const code = await mainWithDeps({ runDriftScan, postToDiscord });
    expect(code).toBe(0);
    expect(runDriftScan).not.toHaveBeenCalled();
    expect(postToDiscord).not.toHaveBeenCalled();
  });

  it('IFLEET_KG_DATABASE_URL unset → no scan, no Discord call (fail-open)', async () => {
    setEnv({ DRIFT_SCAN_ENABLED: '1' });
    const runDriftScan = vi.fn();
    const postToDiscord = vi.fn();
    const code = await mainWithDeps({ runDriftScan, postToDiscord });
    expect(code).toBe(0);
    expect(runDriftScan).not.toHaveBeenCalled();
    expect(postToDiscord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mainWithDeps — happy path + failure-isolation
// ---------------------------------------------------------------------------

describe('mainWithDeps — execution', () => {
  beforeEach(() => {
    setEnv({
      DRIFT_SCAN_ENABLED: '1',
      IFLEET_KG_DATABASE_URL: 'postgres://kg',
    });
  });

  it('on empty result, still posts the operator-confirmation message', async () => {
    const runDriftScan = vi.fn(async (_opts: { repos: string[] }) =>
      result({ candidates: [] }),
    );
    const postToDiscord = vi.fn(async (_msg: string) => undefined);
    const code = await mainWithDeps({ runDriftScan, postToDiscord });
    expect(code).toBe(0);
    expect(runDriftScan).toHaveBeenCalledTimes(1);
    expect(postToDiscord).toHaveBeenCalledTimes(1);
    const msg = postToDiscord.mock.calls[0]![0];
    expect(msg).toContain('clean across 2 repos');
  });

  it('passes the default repo set when DRIFT_SCAN_REPOS is unset', async () => {
    const runDriftScan = vi.fn(async () => result());
    const postToDiscord = vi.fn(async () => undefined);
    await mainWithDeps({ runDriftScan, postToDiscord });
    expect(runDriftScan).toHaveBeenCalledWith({
      repos: ['weautomatehq1/IFleet', 'weautomatehq1/factory'],
    });
  });

  it('honors DRIFT_SCAN_REPOS override', async () => {
    setEnv({ DRIFT_SCAN_REPOS: 'a/b, c/d' });
    const runDriftScan = vi.fn(async () => result());
    const postToDiscord = vi.fn(async () => undefined);
    await mainWithDeps({ runDriftScan, postToDiscord });
    expect(runDriftScan).toHaveBeenCalledWith({ repos: ['a/b', 'c/d'] });
  });

  it('runDriftScan throws → exits without Discord call (fail-open)', async () => {
    // Mimic the substrate's KG-unavailable surface: a thrown error must
    // never reach Discord and never crash the cron.
    class FakeKgUnavailable extends Error {}
    const runDriftScan = vi.fn(async () => {
      throw new FakeKgUnavailable('connection refused');
    });
    const postToDiscord = vi.fn();
    const code = await mainWithDeps({ runDriftScan, postToDiscord });
    expect(code).toBe(0);
    expect(postToDiscord).not.toHaveBeenCalled();
  });

  it('Discord post throws → does NOT propagate, logs warning', async () => {
    const runDriftScan = vi.fn(async () =>
      result({ candidates: [candidate()] }),
    );
    const postToDiscord = vi.fn(async () => {
      throw new Error('discord 503');
    });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const code = await mainWithDeps({ runDriftScan, postToDiscord });
      expect(code).toBe(0);
    } finally {
      console.warn = origWarn;
    }
    expect(postToDiscord).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => /discord post failed/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mainWithDeps — DRIFT_REAL_PR flag (default OFF)
// ---------------------------------------------------------------------------

describe('mainWithDeps — DRIFT_REAL_PR flag', () => {
  beforeEach(() => {
    setEnv({
      DRIFT_SCAN_ENABLED: '1',
      IFLEET_KG_DATABASE_URL: 'postgres://kg',
    });
  });

  it('(a) flag OFF (default) ⇒ report-only: emitDriftPrs is NOT called even with drift candidates', async () => {
    // DRIFT_REAL_PR is left unset by the outer beforeEach.
    const runDriftScan = vi.fn(async () => result({ candidates: [candidate()] }));
    const postToDiscord = vi.fn(async () => undefined);
    const emitDriftPrs = vi.fn(async (_plans: DriftPrPlan[]) => undefined);

    const code = await mainWithDeps({ runDriftScan, postToDiscord, emitDriftPrs });

    expect(code).toBe(0);
    expect(postToDiscord).toHaveBeenCalledTimes(1); // report path unchanged
    expect(emitDriftPrs).not.toHaveBeenCalled(); // real-PR path NOT taken
  });

  it('(b) flag ON ⇒ real-PR path: emitDriftPrs is invoked with the planned PRs', async () => {
    setEnv({ DRIFT_REAL_PR: '1' });
    const runDriftScan = vi.fn(async () => result({ candidates: [candidate()] }));
    const postToDiscord = vi.fn(async () => undefined);
    const emitDriftPrs = vi.fn(async (_plans: DriftPrPlan[]) => undefined);

    const code = await mainWithDeps({ runDriftScan, postToDiscord, emitDriftPrs });

    expect(code).toBe(0);
    expect(postToDiscord).toHaveBeenCalledTimes(1); // report still posted
    expect(emitDriftPrs).toHaveBeenCalledTimes(1); // real-PR path taken
    const plans = emitDriftPrs.mock.calls[0]![0];
    expect(plans).toHaveLength(1);
    expect(plans[0]!.sourceRepo).toBe('weautomatehq1/IFleet');
    expect(plans[0]!.targetRepos).toEqual(['weautomatehq1/factory']);
  });

  it('flag ON but no candidates ⇒ emitDriftPrs not called (nothing to open)', async () => {
    setEnv({ DRIFT_REAL_PR: '1' });
    const runDriftScan = vi.fn(async () => result({ candidates: [] }));
    const postToDiscord = vi.fn(async () => undefined);
    const emitDriftPrs = vi.fn(async (_plans: DriftPrPlan[]) => undefined);

    await mainWithDeps({ runDriftScan, postToDiscord, emitDriftPrs });

    expect(emitDriftPrs).not.toHaveBeenCalled();
  });

  it('flag ON + emitDriftPrs throws ⇒ does NOT propagate (fail-open), still exits 0', async () => {
    setEnv({ DRIFT_REAL_PR: '1' });
    const runDriftScan = vi.fn(async () => result({ candidates: [candidate()] }));
    const postToDiscord = vi.fn(async () => undefined);
    const emitDriftPrs = vi.fn(async () => {
      throw new Error('bridge unavailable');
    });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const code = await mainWithDeps({ runDriftScan, postToDiscord, emitDriftPrs });
      expect(code).toBe(0);
    } finally {
      console.warn = origWarn;
    }
    expect(emitDriftPrs).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => /drift-PR emit failed/.test(w))).toBe(true);
  });
});
