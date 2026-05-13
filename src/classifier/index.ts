import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { RoutingDecision, WorkerSpec, Provider, VerifyKind } from '../pipeline/types.ts';
import { parseLabels } from '../queue/labels.ts';

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

interface RoutingConfig {
  rules: RoutingRule[];
  tiers?: Record<Tier, string>;
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

export interface ClassifyInput {
  title: string;
  body: string;
  labels: string[];
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

  const rawScore = scoreKeywords(text);
  const baseTier = applyLabelBumps(scoreToTier(rawScore), hints.priority, task.labels);

  // Architect escalation policy (Phase B): the scorer never auto-promotes the
  // architect to opus — opus burns the 5-hour Claude Max rate limit and stalls
  // the fleet silently. Only an explicit `complexity:high` label promotes to
  // opus.
  let architectTier: Tier = baseTier === 'opus' ? 'sonnet' : baseTier;
  if (complexity === 'high') architectTier = 'opus';

  const editorTier = bumpTier(architectTier, -1);
  const reviewerTier = architectTier;

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
  // Provider stays claude so the model/provider pair is always consistent;
  // diversity comes from running a fresh reviewer session, not from swapping vendors.
  const reviewerProvider: Provider = 'claude';
  const reviewerModel = TIERS[reviewerTier];

  return {
    architect: makeSpec(architectProvider, architectModel, 'architect'),
    editor: makeSpec(editorProvider, editorModel, 'editor'),
    reviewer: makeSpec(reviewerProvider, reviewerModel, 'reviewer'),
    verify,
  };
}
