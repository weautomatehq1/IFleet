import { describe, expect, it } from 'vitest';

import {
  betaSample,
  posteriorsFromObservations,
  sampleArm,
} from '../thompson.js';

/**
 * Deterministic PRNG (LCG). Same seed → same sequence — important for
 * asserting "the bandit picks X given history Y" without flakiness.
 * Numerical Recipes constants; fine for tests.
 */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('betaSample', () => {
  it('throws on α ≤ 0', () => {
    expect(() => betaSample(0, 1, seededRng(1))).toThrow(/α>0/);
  });

  it('throws on β ≤ 0', () => {
    expect(() => betaSample(1, 0, seededRng(1))).toThrow(/β>0/);
  });

  it('returns a value in [0, 1] for any α, β > 0', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 50; i++) {
      const a = 1 + i * 0.5;
      const b = 1 + (50 - i) * 0.5;
      const x = betaSample(a, b, rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('concentrates near α / (α + β) as the posterior tightens', () => {
    const rng = seededRng(7);
    // Posterior Beta(50, 10) — mean 50/60 ≈ 0.833, std ~0.047.
    const samples = Array.from({ length: 500 }, () => betaSample(50, 10, rng));
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.75);
    expect(mean).toBeLessThan(0.9);
  });
});

describe('sampleArm', () => {
  it('throws on zero arms', () => {
    expect(() => sampleArm([], seededRng(1))).toThrow(/≥1 arm/);
  });

  it('returns the only arm when given one', () => {
    const out = sampleArm([{ arm: 'opus', alpha: 5, beta: 1 }], seededRng(1));
    expect(out.pick).toBe('opus');
    expect(Object.keys(out.samples)).toEqual(['opus']);
  });

  it('over many runs picks the high-mean arm more often than the low-mean arm', () => {
    const arms = [
      { arm: 'opus', alpha: 95, beta: 5 }, // mean ≈ 0.95
      { arm: 'haiku', alpha: 5, beta: 95 }, // mean ≈ 0.05
    ];
    const rng = seededRng(123);
    let opusPicks = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      if (sampleArm(arms, rng).pick === 'opus') opusPicks += 1;
    }
    // Posteriors are this tight: opus should dominate ≥ ~95% of draws.
    expect(opusPicks / N).toBeGreaterThan(0.9);
  });

  it('respects RNG injection — same seed → same pick + same sample map', () => {
    const arms = [
      { arm: 'opus', alpha: 5, beta: 2 },
      { arm: 'sonnet', alpha: 12, beta: 3 },
      { arm: 'haiku', alpha: 8, beta: 8 },
    ];
    const a = sampleArm(arms, seededRng(99));
    const b = sampleArm(arms, seededRng(99));
    expect(a.pick).toBe(b.pick);
    expect(a.samples).toEqual(b.samples);
  });
});

describe('posteriorsFromObservations', () => {
  it('starts every known arm at the uniform Beta(1, 1) prior', () => {
    const out = posteriorsFromObservations([], ['opus', 'sonnet']);
    expect(out).toEqual([
      { arm: 'opus', alpha: 1, beta: 1 },
      { arm: 'sonnet', alpha: 1, beta: 1 },
    ]);
  });

  it('increments α on success, β on failure, per arm', () => {
    const out = posteriorsFromObservations(
      [
        { arm: 'opus', reward: 1 },
        { arm: 'opus', reward: 1 },
        { arm: 'opus', reward: 0 },
        { arm: 'sonnet', reward: 0 },
      ],
      ['opus', 'sonnet'],
    );
    expect(out.find((p) => p.arm === 'opus')).toEqual({ arm: 'opus', alpha: 3, beta: 2 });
    expect(out.find((p) => p.arm === 'sonnet')).toEqual({ arm: 'sonnet', alpha: 1, beta: 2 });
  });

  it('back-fills an unknown arm seen in observations with the prior', () => {
    const out = posteriorsFromObservations(
      [{ arm: 'experimental', reward: 1 }],
      ['opus'],
    );
    expect(out.find((p) => p.arm === 'experimental')).toEqual({
      arm: 'experimental',
      alpha: 2,
      beta: 1,
    });
  });

  it('honours an explicit prior override', () => {
    const out = posteriorsFromObservations(
      [{ arm: 'opus', reward: 1 }],
      ['opus'],
      { alpha: 10, beta: 10 },
    );
    expect(out[0]).toEqual({ arm: 'opus', alpha: 11, beta: 10 });
  });
});
