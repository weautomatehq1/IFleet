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

function matchesGlobs(text: string, globs: string[]): boolean {
  for (const g of globs) {
    for (const needle of globToSubstrings(g)) {
      if (text.includes(needle)) return true;
    }
  }
  return false;
}

export function classifyTask(task: ClassifyInput): RoutingDecision {
  const text = `${task.title} ${task.body}`.toLowerCase();
  const hints = parseLabels(task.labels);
  const complexity = parseComplexity(task.labels);
  // Mode precedence: explicit field on input > `mode:*` label > body header /
  // slash-prefix. Auto-router is invoked separately by `classifyTaskAsync`
  // when no synchronous signal is present.
  const explicitMode =
    task.mode ?? detectExplicitMode({ labels: task.labels, body: task.body });

  const rawScore = scoreKeywords(text);
  const baseTier = applyLabelBumps(scoreToTier(rawScore), hints.priority, task.labels);

  // Architect escalation policy (Phase B): the scorer never auto-promotes the
  // architect to opus — opus burns the 5-hour Claude Max rate limit and stalls
  // the fleet silently. Only an explicit `complexity:high` label promotes to
  // opus.
  let architectTier: Tier = baseTier === 'opus' ? 'sonnet' : baseTier;
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
  // globally so rule order in routing.json still has meaning.
  let matchedRule: RoutingRule | undefined;
  for (const rule of config.rules) {
    const keywordHit =
      rule.match.keywords?.some((kw) => text.includes(kw.toLowerCase())) ?? false;
    const globHit = rule.match.fileGlobs ? matchesGlobs(text, rule.match.fileGlobs) : false;
    if (keywordHit || globHit) {
      matchedRule = rule;
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

  // Architect opus cap (Phase B): no path other than `complexity:high` can
  // promote the architect to opus — not scorer keywords, not routing.json
  // rules. This keeps the fleet off the 5-hour rate limit by default.
  if (complexity !== 'high' && architectModel === TIERS.opus) {
    architectModel = TIERS.sonnet;
  }

  // Reviewer is a Claude second opinion at the same tier as the architect.
  // Tier is derived from the *final* architectModel (post rule override + opus
  // cap), not the pre-rule architectTier — otherwise a rule that promotes the
  // architect from haiku→opus and is then capped to sonnet would leave the
  // reviewer back at haiku, violating reviewer >= architect.
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

  // Apply mode-specific overrides last so they can pin a model on top of the
  // rule + cap pipeline without re-entering tier math. Mode is null/undefined
  // when no explicit signal is present; the async classifier may supply one.
  if (explicitMode && config.modes?.[explicitMode]) {
    const override = config.modes[explicitMode];
    if (override?.architect) architectModel = override.architect;
    if (override?.editor) editorModel = override.editor;
    if (override?.verify) {
      for (const v of override.verify) if (!verify.includes(v)) verify.push(v);
    }
  }

  // Plan-Reviewer (M2 — see docs/elevation/upgrades/02-plan-reviewer.md).
  // Floor: "reviewer not weaker than architect". Default is haiku; bump to
  // the architect's tier (capped at sonnet — opus plan-review burns the same
  // rate limit the architect cap exists to protect). Same provider as the
  // architect — this is in-flight plan critique, not a cross-provider diff
  // review.
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
