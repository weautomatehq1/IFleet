// M6-T2 — Thompson sampling bandit, substrate.
//
// Tracks a Beta(α, β) posterior over success rate for each "arm" (model
// id). On every call to `sampleArm`, draws one sample from each arm's
// posterior and returns the arm with the highest draw. The exploration
// vs. exploitation tradeoff is implicit in the variance of the Beta —
// arms with few observations get wide samples, arms with many get
// narrow ones.
//
// This module is PURE — no I/O, no clock, no global state. The RNG is
// injected so tests are deterministic. The caller (`shadow.ts`) is
// responsible for loading the prior from `pr_decisions` and persisting
// the shadow pick.

export interface ArmPosterior {
  /** Stable arm identifier — for routing, this is the model id. */
  arm: string;
  /** Pseudo-count of successes (merged PRs). Includes any prior. */
  alpha: number;
  /** Pseudo-count of failures (rejected PRs). Includes any prior. */
  beta: number;
}

export interface SampleResult {
  /** Posterior sample per arm — useful for the shadow_log snapshot. */
  samples: Record<string, number>;
  /** Arm with the highest sample. */
  pick: string;
}

/**
 * Draw one sample from each arm's Beta(α, β) posterior and return both
 * the full sample map (so shadow logging can record it) and the
 * argmax arm. Ties (same sample value) break by the order arms were
 * passed — caller controls determinism by sorting if it matters.
 *
 * Throws when given zero arms — a no-arm sample has no meaning. The
 * caller can fall back to the live routing decision in that case.
 */
export function sampleArm(
  arms: readonly ArmPosterior[],
  rng: () => number = Math.random,
): SampleResult {
  if (arms.length === 0) {
    throw new Error('sampleArm requires ≥1 arm');
  }
  const samples: Record<string, number> = {};
  let bestArm = arms[0]!.arm;
  let bestVal = -Infinity;
  for (const a of arms) {
    const s = betaSample(a.alpha, a.beta, rng);
    samples[a.arm] = s;
    if (s > bestVal) {
      bestVal = s;
      bestArm = a.arm;
    }
  }
  return { samples, pick: bestArm };
}

/**
 * Beta(α, β) sample via ratio of two Gamma(·, 1) draws.
 *   Beta(α, β) = X / (X + Y) where X ~ Gamma(α, 1), Y ~ Gamma(β, 1).
 * Standard textbook identity.
 *
 * Edge cases:
 *  - α ≤ 0 or β ≤ 0 → throws. Callers must initialize priors to
 *    strictly positive values (the canonical Beta(1, 1) uniform prior
 *    is fine).
 *  - Both gammas return 0 (vanishingly unlikely for α, β > 0) → returns
 *    0.5 to avoid NaN.
 */
export function betaSample(alpha: number, beta: number, rng: () => number): number {
  if (!(alpha > 0) || !(beta > 0)) {
    throw new Error(`betaSample requires α>0 and β>0; got α=${alpha} β=${beta}`);
  }
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta, rng);
  const denom = x + y;
  if (denom === 0) return 0.5;
  return x / denom;
}

/**
 * Gamma(shape, 1) sample via Marsaglia–Tsang for shape ≥ 1, with the
 * standard boost-and-rescale trick for shape < 1
 * (`Gamma(shape) = Gamma(shape+1) * U^(1/shape)`).
 *
 * Not the world's fastest sampler but correct, deterministic given the
 * RNG, and free of dependencies. Adequate for substrate work.
 */
function gammaSample(shape: number, rng: () => number): number {
  if (shape < 1) {
    return gammaSample(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // The loop is rejection-sampling; expected iterations < 1.05 for any
  // shape ≥ 1.
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Standard normal via Box–Muller. Cheap, deterministic, fine for the
 * inner loop above. We consume two uniforms per call but only return
 * one of the two; gammaSample's loop only needs one normal at a time so
 * the second is discarded — correct, just slightly wasteful.
 */
function standardNormal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Build per-arm posteriors from a flat list of observed (arm, reward)
 * pairs. `reward` is 1 for a success (merged) and 0 for a failure
 * (rejected). The optional `prior` sets the starting α/β before any
 * data is folded in; the default Beta(1, 1) is the uniform prior — no
 * arm starts privileged.
 */
export function posteriorsFromObservations(
  observations: ReadonlyArray<{ arm: string; reward: 0 | 1 }>,
  knownArms: readonly string[],
  prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 },
): ArmPosterior[] {
  const posteriors = new Map<string, ArmPosterior>();
  for (const a of knownArms) {
    posteriors.set(a, { arm: a, alpha: prior.alpha, beta: prior.beta });
  }
  for (const obs of observations) {
    let p = posteriors.get(obs.arm);
    if (!p) {
      p = { arm: obs.arm, alpha: prior.alpha, beta: prior.beta };
      posteriors.set(obs.arm, p);
    }
    if (obs.reward === 1) p.alpha += 1;
    else p.beta += 1;
  }
  return Array.from(posteriors.values()).sort((a, b) => a.arm.localeCompare(b.arm));
}
