import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { RoutingDecision, SprintMode, WorkerSpec, Provider, VerifyKind } from '../pipeline/types.ts';
import { parseLabels } from '../queue/labels.ts';
import { detectExplicitMode } from './modes.ts';
import {
  autoRouteMode,
  isBelowConfidenceThreshold,
  type AutoRouterDecision,
  type AutoRouterOptions,
} from './auto-router.ts';

type Tier = 'haiku' | 'sonnet' | 'opus';

interface RouteSpec {
  provider: string;
  model: string;
  role?: 'architect' | 'editor';
  verify?: VerifyKind[];
}

interface RoutingRule {
  match: {
    keywords?: string[];
    fileGlobs?: string[];
  };
  route: RouteSpec;
}

interface ModeOverride {
  /** Override architect model when this mode is active. */
  architect?: string;
  /** Override editor model when this mode is active. */
  editor?: string;
  /** Extra verify kinds appended (deduped) when this mode is active. */
  verify?: VerifyKind[];
}

interface RoutingConfig {
  rules: RoutingRule[];
  tiers?: Record<Tier, string>;
  /** Per-sprint-mode overrides applied after rule + cap logic. Optional. */
  modes?: Partial<Record<SprintMode, ModeOverride>>;
}

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const config: RoutingConfig = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'config', 'routing.json'), 'utf-8'),
) as RoutingConfig;

const FALLBACK_TIERS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

const TIERS: Record<Tier, string> = { ...FALLBACK_TIERS, ...(config.tiers ?? {}) };

const HIGH_KEYWORDS = [
  'auth',
  'security',
  'migration',
  'rls',
  'critical',
  'oauth',
  'encryption',
  'payment',
  'stripe',
  'supabase',
];

const MEDIUM_KEYWORDS = [
  'refactor',
  'feature',
  'component',
  'api',
  'route',
  'integration',
  'hook',
  'service',
];

// Category-detection needles for M4.6 (mode override category protection).
// Includes HIGH_KEYWORDS (which covers auth/security/migration/rls/critical/
// oauth/encryption/payment/stripe/supabase) plus 'sql' so the SQL fileGlob
// rule (migration category) is detected as a category override too.
const CATEGORY_NEEDLES = [...HIGH_KEYWORDS, 'sql'];

// M4.7 (ADR-0004 §Known-Limitations item 2): canonical §3.2 override #1
// category vocabulary, used when an operator labels an issue `category:*`
// explicitly. Matches the parser whitelist in `src/queue/labels.ts`.
const OPUS_CATEGORIES: ReadonlySet<NonNullable<import('../queue/types.ts').RoutingHints['category']>> =
  new Set(['security', 'auth', 'payments', 'migration'] as const);

const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

// Inverse lookup: given a model string, return the tier it represents.
// Used to keep the reviewer at the same tier as the architect *after* the
// rule override and opus cap have run — see classifyTask below.
function modelToTier(model: string): Tier | undefined {
  for (const tier of TIER_ORDER) {
    if (TIERS[tier] === model) return tier;
  }
  return undefined;
}

export interface ClassifyInput {
  title: string;
  body: string;
  labels: string[];
  /**
   * Optional pre-decided mode. When supplied, it wins over label/body detection
   * — operators can pin a mode via Discord slash-command and bypass detection.
   */
  mode?: SprintMode | null;
}

function makeSpec(provider: string, model: string, role: string): WorkerSpec {
  return {
    provider: provider as Provider,
    model,
    workerId: `${provider}-${role}-1`,
  };
}

function scoreKeywords(text: string): number {
  let score = 0;
  for (const kw of HIGH_KEYWORDS) {
    if (text.includes(kw)) score += 3;
  }
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) score += 1;
  }
  return score;
}


function scoreToTier(score: number): Tier {
  if (score >= 3) return 'opus';
  if (score >= 1) return 'sonnet';
  return 'haiku';
}

function bumpTier(tier: Tier, delta: number): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  const next = Math.max(0, Math.min(TIER_ORDER.length - 1, idx + delta));
  return TIER_ORDER[next] as Tier;
}

function applyLabelBumps(
  tier: Tier,
  priority: 'low' | 'normal' | 'high',
  labels: readonly string[],
): Tier {
  let next = tier;
  if (priority === 'high') next = bumpTier(next, 1);
  for (const raw of labels) {
    const l = raw.toLowerCase().trim();
    if (l === 'chore' || l === 'docs' || l.startsWith('chore:') || l.startsWith('docs:')) {
      next = bumpTier(next, -1);
    }
  }
  return next;
}

type ComplexityHint = 'high' | 'low' | undefined;

function parseComplexity(labels: readonly string[]): ComplexityHint {
  for (const raw of labels) {
    const l = raw.toLowerCase().trim();
    if (l === 'complexity:high') return 'high';
    if (l === 'complexity:low') return 'low';
  }
  return undefined;
}

// Translate a glob pattern into substring needles we can probe the task text with.
// We don't have a real file tree at classify time, so we look for filename
// extensions (e.g. ".sql") and top-level directory prefixes (e.g. "migrations/").
function globToSubstrings(glob: string): string[] {
  const needles: string[] = [];
  const extMatch = glob.match(/\*\.([A-Za-z0-9]+)$/);
  if (extMatch && extMatch[1]) needles.push(`.${extMatch[1].toLowerCase()}`);
  const dirMatch = glob.match(/^([A-Za-z0-9_.-]+)\/\*\*/);
  if (dirMatch && dirMatch[1]) needles.push(`${dirMatch[1].toLowerCase()}/`);
  return needles;
}

export function classifyTask(task: ClassifyInput): RoutingDecision {
  const text = `${task.title} ${task.body}`.toLowerCase();
  const hints = parseLabels(task.labels);
  const complexity = parseComplexity(task.labels);
  // M4.6: tracks whether canonical §3.2 override #1 (category-driven Opus)
  // or #2 (CRITICAL-driven Opus) has fired. When true, a subsequent
  // mode-override block must NOT demote the architect below Opus.
  let categoryOverrideTriggered = false;
  // Mode precedence: explicit field on input > `mode:*` label > body header /
  // slash-prefix. Auto-router is invoked separately by `classifyTaskAsync`
  // when no synchronous signal is present.
  const explicitMode =
    task.mode ?? detectExplicitMode({ labels: task.labels, body: task.body });

  const rawScore = scoreKeywords(text);
  const baseTier = applyLabelBumps(scoreToTier(rawScore), hints.priority, task.labels);
  // M4.6 trigger #1: scorer-driven Opus assignment (HIGH_KEYWORDS hit
  // produced score ≥3, optionally combined with priority bumps). This is
  // canonical §3.2 override #1 firing through the scorer path.
  if (baseTier === 'opus') categoryOverrideTriggered = true;

  // Architect escalation policy (canonical correctness-first, post-M4.5 / ADR-0004):
  // the scorer is allowed to promote the architect to opus on its own — high-risk
  // keywords (auth/security/migration/payments/critical) carry mistake-cost that
  // exceeds Opus's marginal cost, and the cross-provider review gate makes the
  // cheaper tiers safe by catching regressions. `complexity:high` remains a manual
  // override for cases the scorer underestimates; `complexity:low` has no effect
  // on the category override (canonical §3.2 override #1 wins regardless of severity).
  let architectTier: Tier = baseTier;

  // M4.7 (ADR-0004 §Known-Limitations item 2): explicit `category:*` /
  // `severity:*` label-driven overrides. Canonical §3.2 override #1
  // (category ∈ {security, auth, payments, migration} → Opus regardless of
  // severity) and override #2 (CRITICAL severity → Opus regardless of
  // category) are direct signals from the operator — they don't require a
  // title keyword to fire. Both also set M4.6's `categoryOverrideTriggered`
  // flag so the downstream mode-override block refuses to demote the
  // architect below Opus.
  if (hints.category && OPUS_CATEGORIES.has(hints.category)) {
    architectTier = 'opus';
    categoryOverrideTriggered = true;
  }
  if (hints.severity === 'critical') {
    architectTier = 'opus';
    categoryOverrideTriggered = true;
  }

  if (complexity === 'high') architectTier = 'opus';

  const rawEditorTier = bumpTier(architectTier, -1);
  // Editor must be at least sonnet — haiku in `claude -p` print mode reliably
  // returns ok=true but produces zero file edits, which then burns reviewer
  // tokens on an empty diff. Floor the editor tier at sonnet.
  const editorTier: Tier =
    TIER_ORDER.indexOf(rawEditorTier) >= TIER_ORDER.indexOf('sonnet') ? rawEditorTier : 'sonnet';

  let architectProvider: string = 'claude';
  let architectModel: string = TIERS[architectTier];
  let editorProvider: string = 'claude';
  let editorModel: string = TIERS[editorTier];

  // Rules act as explicit overrides on top of the scorer. First match wins
  // globally so rule order in routing.json still has meaning. We also track
  // which specific keyword / fileGlob actually hit — M4.6 trigger #2 below
  // needs the precise matched signal, not the rule's whole declared list,
  // to avoid blocking mode demotions on tasks that match a mixed-keyword
  // rule via a non-category keyword like "architect" or "design".
  let matchedRule: RoutingRule | undefined;
  let matchedKeyword: string | undefined;
  let matchedGlob: string | undefined;
  for (const rule of config.rules) {
    const keywordHit = rule.match.keywords?.find((kw) => text.includes(kw.toLowerCase()));
    let globHit: string | undefined;
    if (rule.match.fileGlobs) {
      for (const g of rule.match.fileGlobs) {
        for (const needle of globToSubstrings(g)) {
          if (text.includes(needle)) {
            globHit = g;
            break;
          }
        }
        if (globHit) break;
      }
    }
    if (keywordHit || globHit) {
      matchedRule = rule;
      matchedKeyword = keywordHit;
      matchedGlob = globHit;
      break;
    }
  }

  if (matchedRule) {
    const { provider, model, role } = matchedRule.route;
    if (role === 'architect') {
      architectProvider = provider;
      architectModel = model;
    } else if (role === 'editor') {
      editorProvider = provider;
      editorModel = model;
    }
    // M4.6 trigger #2: a rule that routes architect → Opus AND whose
    // ACTUAL matched signal (the specific keyword that hit, or the specific
    // glob that hit) overlaps a canonical category needle (auth/security/
    // migration/payments/rls/critical/oauth/encryption/stripe/supabase/sql).
    // We inspect the matched signal, not the rule's declared keyword list,
    // so a rule that mixes architectural-design keywords (architect/design)
    // with category keywords (auth/security/migration) only flips the flag
    // when the canonical category keyword is the one that actually hit.
    // Explicit `category:*` labels are out of scope here — tracked as M4.7.
    if (matchedRule.route.role === 'architect' && matchedRule.route.model === TIERS.opus) {
      const signal = (matchedKeyword ?? matchedGlob ?? '').toLowerCase();
      if (signal && CATEGORY_NEEDLES.some((needle) => signal.includes(needle))) {
        categoryOverrideTriggered = true;
      }
    }
  }

  // Union rule-driven verify steps with label-driven hints so neither side is
  // silently dropped. Label hints are preserved; rule verify (e.g. playwright
  // for .tsx/components) is added on top. De-duplicate while keeping order.
  const verify: VerifyKind[] = [...hints.verify];
  if (matchedRule?.route.verify) {
    for (const v of matchedRule.route.verify) {
      if (!verify.includes(v)) verify.push(v);
    }
  }

  // Canonical override (post-M4.5 / ADR-0004 / canonical §3.2): no Opus cap.
  // Rule-driven Opus assignments (security/migration/auth/payments) are honored
  // directly. Rate-limit risk that motivated the Phase B cap is mitigated by
  // (a) the cross-provider review gate that catches regressions before merge,
  // and (b) the OMC wait/resume wrapper that pauses sprints cleanly when a
  // Claude Max window hits. Multi-seat rotation via src/workers/account-pool.ts
  // is the long-term mitigation — see ADR-0004 §Consequences for the actual
  // present seat count.

  // Apply mode-specific overrides on top of the rule + cap pipeline. Mode is
  // null/undefined when no explicit signal is present; the async classifier
  // may supply one.
  //
  // M4.6 (mode override category protection): when canonical §3.2 override
  // #1/#2 has fired (`categoryOverrideTriggered` set during scorer + rule
  // application), a mode override MUST NOT demote the architect below Opus.
  // Canonical §3.2 says override #1 wins "regardless of severity"; we extend
  // that to "regardless of mode". Editor + verify overrides still apply —
  // only the architect override is gated.
  if (explicitMode && config.modes?.[explicitMode]) {
    const override = config.modes[explicitMode];
    if (override?.architect) {
      const overrideWouldDemote =
        architectModel === TIERS.opus && override.architect !== TIERS.opus;
      if (overrideWouldDemote && categoryOverrideTriggered) {
        // M4.6: skip the architect override; the category/critical override
        // takes precedence over the mode demotion. Editor/verify below still
        // apply so the rest of the mode contract is honored.
      } else {
        architectModel = override.architect;
      }
    }
    if (override?.editor) editorModel = override.editor;
    if (override?.verify) {
      for (const v of override.verify) if (!verify.includes(v)) verify.push(v);
    }
  }

  // M4.8: reviewer derivation moved here (was previously before the mode-
  // override block) so the reviewer mirrors the FINAL architectModel — i.e.
  // the architect after any mode demotion or M4.6 protection has been
  // applied. Reviewer is a Claude second opinion at the architect's tier;
  // if a mode demotes architect, the reviewer follows so the "reviewer not
  // weaker than architect" invariant holds.
  const reviewerProvider: Provider = 'claude';
  const reviewerTier: Tier = modelToTier(architectModel) ?? architectTier;
  const reviewerModel = TIERS[reviewerTier];

  // Reviewer cost split: cheap haiku pre-pass runs before the full reviewer.
  // CLEAN diffs (style-only, mechanical) short-circuit; anything ambiguous or
  // risky falls through to the full reviewer. The gate uses the same provider
  // as the full reviewer (claude) at the haiku tier — see TIERS.haiku.
  const haikuGate: WorkerSpec = {
    provider: reviewerProvider,
    model: TIERS.haiku,
    workerId: `${reviewerProvider}-reviewer-gate-1`,
  };

  // Plan-Reviewer (M2 — see docs/elevation/upgrades/02-plan-reviewer.md).
  // Floor: "reviewer not weaker than architect". Default is haiku; bump to
  // the architect's tier. Capped at sonnet per canonical §2.5 which specifies
  // "Haiku or Sonnet" for the Plan-Reviewer — it's a cheap pre-gate that runs
  // BEFORE the Editor, not a full diff review. Same provider as the architect:
  // this is in-flight plan critique, not a cross-provider diff review.
  const architectTierFinal: Tier = modelToTier(architectModel) ?? architectTier;
  const planReviewerTier: Tier =
    architectTierFinal === 'opus'
      ? 'sonnet'
      : architectTierFinal === 'sonnet'
        ? 'haiku'
        : 'haiku';
  const planReviewer: WorkerSpec = makeSpec(
    architectProvider,
    TIERS[planReviewerTier],
    'plan-reviewer',
  );

  const decision: RoutingDecision = {
    architect: makeSpec(architectProvider, architectModel, 'architect'),
    editor: makeSpec(editorProvider, editorModel, 'editor'),
    reviewer: makeSpec(reviewerProvider, reviewerModel, 'reviewer'),
    planReviewer,
    haikuGate,
    verify,
  };
  if (explicitMode) decision.mode = explicitMode;
  return decision;
}

/**
 * Async variant: runs {@link classifyTask} synchronously, then — if no explicit
 * mode was detected — calls the Haiku auto-router and reapplies mode overrides.
 *
 * Confidence < 0.6 falls back to `standard` and surfaces a Discord-review note
 * via the supplied `onLowConfidence` callback so the operator can intervene.
 */
export async function classifyTaskAsync(
  task: ClassifyInput,
  opts: {
    autoRouter?: AutoRouterOptions;
    /** Repo root forwarded to the auto-router for learnings + security lookup. */
    repoRoot?: string;
    /**
     * Called when the auto-router returned a decision below the confidence
     * threshold. Implementations should post a Discord note flagging the task
     * for human review. Failures are swallowed — observability must not break
     * routing.
     */
    onLowConfidence?: (decision: AutoRouterDecision) => void | Promise<void>;
  } = {},
): Promise<RoutingDecision> {
  const synchronous = classifyTask(task);
  if (synchronous.mode) return synchronous;

  const decision = await autoRouteMode(
    { title: task.title, body: task.body, labels: task.labels, ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}) },
    opts.autoRouter ?? {},
  );

  if (isBelowConfidenceThreshold(decision)) {
    if (opts.onLowConfidence) {
      try {
        await opts.onLowConfidence(decision);
      } catch {
        // observability must not break routing
      }
    }
    // Re-run classifyTask without a mode override so we get the same baseline.
    return synchronous;
  }

  // Re-run classifyTask with the model-chosen mode so mode overrides apply.
  return classifyTask({ ...task, mode: decision.mode });
}
