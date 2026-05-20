/**
 * Canary alerter — covers the three behaviors the cron must guarantee:
 *   1. Threshold cross (below → above) emits a "tripped" post.
 *   2. Recovery (above → below) emits a "recovered" post.
 *   3. Steady-state ticks (above→above, below→below) do NOT repost (dedup).
 *
 * Plus: first-ever evaluation is a silent baseline, and insufficient
 * samples (<5) never alerts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanaryStateStore } from '../state-store.js';
import {
  DEFAULT_DISAGREEMENT_THRESHOLD,
  evaluateTransition,
  formatAlertMessage,
  runCanaryAlert,
} from '../alert.js';
import type { DisagreementSnapshot } from '../../verifier/store-bridge.js';

function snap(rate: number | null, total = 20, failed = Math.round((rate ?? 0) * total)): DisagreementSnapshot {
  return {
    rate,
    total,
    failed,
    windowDays: 7,
    sinceMs: 1000,
    computedAtMs: 2000,
  };
}

interface FakeBridge {
  getDisagreementSnapshot: () => DisagreementSnapshot;
}

function fakeBridge(value: DisagreementSnapshot): FakeBridge {
  return { getDisagreementSnapshot: () => value };
}

let dir: string;
let store: CanaryStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-alert-'));
  store = new CanaryStateStore({ path: join(dir, 'state.json') });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('evaluateTransition (pure)', () => {
  it('returns none + insufficient-samples when rate is null', () => {
    const out = evaluateTransition(
      { kind: 'unknown', lastTransitionRate: null, lastTransitionAtMs: null },
      snap(null, 3, 1),
      DEFAULT_DISAGREEMENT_THRESHOLD,
      100,
    );
    expect(out.transition).toBe('none');
    expect(out.reason).toBe('insufficient-samples');
    expect(out.next).toEqual(out.prior);
  });

  it('records baseline silently on first sufficient-sample tick', () => {
    const out = evaluateTransition(
      { kind: 'unknown', lastTransitionRate: null, lastTransitionAtMs: null },
      snap(0.4),
      0.25,
      100,
    );
    expect(out.transition).toBe('none');
    expect(out.reason).toBe('baseline-above');
    expect(out.next.kind).toBe('above');
    expect(out.next.lastTransitionAtMs).toBe(100);
  });

  it('alerts on below → above', () => {
    const out = evaluateTransition(
      { kind: 'below', lastTransitionRate: 0.1, lastTransitionAtMs: 50 },
      snap(0.3),
      0.25,
      200,
    );
    expect(out.transition).toBe('tripped');
    expect(out.reason).toBe('crossed-up');
    expect(out.next.kind).toBe('above');
    expect(out.next.lastTransitionRate).toBe(0.3);
  });

  it('alerts on above → below', () => {
    const out = evaluateTransition(
      { kind: 'above', lastTransitionRate: 0.4, lastTransitionAtMs: 50 },
      snap(0.1),
      0.25,
      200,
    );
    expect(out.transition).toBe('recovered');
    expect(out.reason).toBe('crossed-down');
    expect(out.next.kind).toBe('below');
  });

  it('does not re-alert while staying above', () => {
    const out = evaluateTransition(
      { kind: 'above', lastTransitionRate: 0.4, lastTransitionAtMs: 50 },
      snap(0.35),
      0.25,
      200,
    );
    expect(out.transition).toBe('none');
    expect(out.reason).toBe('still-above');
    expect(out.next).toEqual(out.prior);
  });

  it('does not re-alert while staying below', () => {
    const out = evaluateTransition(
      { kind: 'below', lastTransitionRate: 0.1, lastTransitionAtMs: 50 },
      snap(0.05),
      0.25,
      200,
    );
    expect(out.transition).toBe('none');
    expect(out.reason).toBe('still-below');
  });

  it('treats rate exactly at threshold as above', () => {
    const out = evaluateTransition(
      { kind: 'below', lastTransitionRate: 0.1, lastTransitionAtMs: 50 },
      snap(0.25),
      0.25,
      200,
    );
    expect(out.transition).toBe('tripped');
  });
});

describe('runCanaryAlert (integration)', () => {
  it('posts once on threshold cross, then NOT again on the next steady tick', async () => {
    // Tick 0: baseline below — no post.
    const posts: string[] = [];
    const postAlert = vi.fn(async (m: string) => {
      posts.push(m);
    });

    await runCanaryAlert({
      bridge: fakeBridge(snap(0.1)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 1_000,
    });
    expect(posts).toHaveLength(0);
    expect(store.read().kind).toBe('below');

    // Tick 1: crosses above — POSTS.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.4)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 2_000,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/Canary tripped/);
    expect(store.read().kind).toBe('above');

    // Tick 2: still above — DOES NOT REPOST (dedup).
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.35)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 3_000,
    });
    expect(posts).toHaveLength(1);

    // Tick 3: drops below — RECOVERY post.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.05)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 4_000,
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/Canary recovered/);
    expect(store.read().kind).toBe('below');

    // Tick 4: still below — DOES NOT REPOST.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.0)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 5_000,
    });
    expect(posts).toHaveLength(2);
  });

  it('never posts when sample count is below the minimum', async () => {
    const postAlert = vi.fn(async () => undefined);
    const ev = await runCanaryAlert({
      bridge: fakeBridge(snap(null, 3, 1)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 1_000,
    });
    expect(postAlert).not.toHaveBeenCalled();
    expect(ev.reason).toBe('insufficient-samples');
    expect(store.read().kind).toBe('unknown');
  });

  it('first-ever above-threshold tick is silent (baseline), second is a cross-up if it recovers + retrips', async () => {
    const posts: string[] = [];
    const postAlert = vi.fn(async (m: string) => {
      posts.push(m);
    });

    // First sufficient-sample tick happens to be above — silent baseline.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.5)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 1_000,
    });
    expect(posts).toHaveLength(0);
    expect(store.read().kind).toBe('above');

    // It recovers — post recovered.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.05)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 2_000,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/recovered/);

    // It re-trips — post tripped.
    await runCanaryAlert({
      bridge: fakeBridge(snap(0.3)),
      store,
      postAlert,
      threshold: 0.25,
      now: () => 3_000,
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/tripped/);
  });
});

describe('formatAlertMessage', () => {
  it('renders the tripped message with rate and sample counts', () => {
    const text = formatAlertMessage({
      snapshot: snap(0.42, 50, 21),
      threshold: 0.25,
      transition: 'tripped',
      inspectionHint: 'sqlite> SELECT * FROM verifier_runs WHERE status=\'failed\';',
    });
    expect(text).toMatch(/🚨/);
    expect(text).toMatch(/42\.0%/);
    expect(text).toMatch(/25\.0%/);
    expect(text).toMatch(/21\/50/);
    expect(text).toMatch(/last 7d/);
    expect(text).toMatch(/SELECT \* FROM verifier_runs/);
  });

  it('renders the recovered message', () => {
    const text = formatAlertMessage({
      snapshot: snap(0.05, 40, 2),
      threshold: 0.25,
      transition: 'recovered',
    });
    expect(text).toMatch(/✅/);
    expect(text).toMatch(/recovered/);
    expect(text).toMatch(/5\.0%/);
    expect(text).toMatch(/2\/40/);
  });
});
