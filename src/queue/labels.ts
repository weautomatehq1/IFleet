import type { Octokit } from '@octokit/rest';
import {
  LABEL_AUTO_SHIP,
  LABEL_CAPABILITY_BLOCKED,
  LABEL_FAILED,
  LABEL_IN_FLIGHT,
  LABEL_SHIPPED,
  type RepoRef,
  type RoutingHints,
  type VerifyKind,
} from '@wahq/orchestrator-core/queue/types';

const MODELS = new Set(['opus', 'sonnet', 'haiku', 'codex'] as const);
const PRIORITIES = new Set(['low', 'normal', 'high'] as const);
// M4.7 (ADR-0004 §Known-Limitations item 2): explicit category/severity label
// vocabularies. Mirrors canonical §3.2 override #1 (category) and #2 (severity).
const CATEGORIES = new Set(['security', 'auth', 'payments', 'migration'] as const);
const SEVERITIES = new Set(['critical', 'important', 'cosmetic'] as const);

type Model = NonNullable<RoutingHints['model']>;
type Priority = RoutingHints['priority'];
type Category = NonNullable<RoutingHints['category']>;
type Severity = NonNullable<RoutingHints['severity']>;

const DEFAULT_VERIFY: VerifyKind[] = ['typecheck', 'lint', 'test'];

export function parseLabels(labels: readonly string[]): RoutingHints {
  let model: Model | undefined;
  let priority: Priority = 'normal';
  let autonomy: RoutingHints['autonomy'] = 'auto';
  let verifyOverride: VerifyKind[] | undefined;
  let verifyNone = false;
  // M4.7: explicit category/severity label parsing. Multiple category labels —
  // first match wins (don't try to combine). Unknown values are logged + ignored.
  let category: Category | undefined;
  let severity: Severity | undefined;

  for (const raw of labels) {
    const label = raw.toLowerCase().trim();
    const colon = label.indexOf(':');
    if (colon === -1) continue;
    const key = label.slice(0, colon);
    const value = label.slice(colon + 1);

    switch (key) {
      case 'model':
        if (isModel(value)) model = value;
        break;
      case 'priority':
        if (isPriority(value)) priority = value;
        break;
      case 'autonomy':
        if (value === 'auto' || value === 'review') autonomy = value;
        break;
      case 'verify':
        if (value === 'none') {
          verifyNone = true;
        } else if (value === 'ui') {
          verifyOverride = mergeVerify(verifyOverride, ['playwright', 'screenshot']);
        } else if (isVerifyKind(value)) {
          verifyOverride = mergeVerify(verifyOverride, [value]);
        }
        break;
      case 'category':
        if (isCategory(value)) {
          // First match wins — leave existing assignment in place.
          if (category === undefined) category = value;
        } else {
          // Hot path: never throw on operator typos. One-line dev log only.
          console.warn(`[labels] ignoring unknown category label: category:${value}`);
        }
        break;
      case 'severity':
        if (isSeverity(value)) {
          if (severity === undefined) severity = value;
        } else {
          console.warn(`[labels] ignoring unknown severity label: severity:${value}`);
        }
        break;
      default:
        break;
    }
  }

  let verify: VerifyKind[];
  if (verifyNone && autonomy === 'auto') {
    verify = [];
  } else if (verifyOverride) {
    verify = verifyOverride;
  } else {
    verify = [...DEFAULT_VERIFY];
  }

  const hints: RoutingHints = { priority, verify, autonomy };
  if (model !== undefined) hints.model = model;
  if (category !== undefined) hints.category = category;
  if (severity !== undefined) hints.severity = severity;
  return hints;
}

function isModel(value: string): value is Model {
  return (MODELS as Set<string>).has(value);
}

function isPriority(value: string): value is Priority {
  return (PRIORITIES as Set<string>).has(value);
}

function isVerifyKind(value: string): value is VerifyKind {
  return value === 'typecheck' || value === 'lint' || value === 'test' || value === 'playwright' || value === 'screenshot';
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as Set<string>).has(value);
}

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as Set<string>).has(value);
}

export function parseRequiredCapabilities(labels: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of labels) {
    const label = raw.toLowerCase().trim();
    if (label.startsWith('requires:')) {
      const cap = label.slice('requires:'.length);
      if (cap.length > 0) result.push(cap);
    }
  }
  return result;
}

function mergeVerify(current: VerifyKind[] | undefined, additions: VerifyKind[]): VerifyKind[] {
  const next = current ? [...current] : [];
  for (const kind of additions) {
    if (!next.includes(kind)) next.push(kind);
  }
  return next;
}

export interface LabelSpec {
  name: string;
  color: string;
  description?: string;
}

export const REQUIRED_LABELS: readonly LabelSpec[] = [
  { name: LABEL_AUTO_SHIP, color: '0e8a16', description: 'Pick up via IFleet autonomous queue' },
  { name: LABEL_IN_FLIGHT, color: 'fbca04', description: 'Currently being worked by an IFleet worker' },
  { name: LABEL_SHIPPED, color: '6f42c1', description: 'IFleet shipped a PR for this issue' },
  { name: LABEL_FAILED, color: 'd73a4a', description: 'IFleet attempted but failed' },
  { name: LABEL_CAPABILITY_BLOCKED, color: 'b60205', description: 'Missing runner capability; not pickable' },
];

export interface EnsureLabelsResult {
  /** Labels newly created on the repo during this call. */
  created: string[];
  /** Labels that already existed and were left untouched. */
  existed: string[];
}

/**
 * Idempotently ensure the given labels exist on a repository. Safe to call on
 * every startup — labels that already exist short-circuit without error.
 */
export async function ensureLabels(
  octokit: Octokit,
  repo: RepoRef,
  labels: readonly LabelSpec[] = REQUIRED_LABELS,
): Promise<EnsureLabelsResult> {
  const result: EnsureLabelsResult = { created: [], existed: [] };
  for (const spec of labels) {
    try {
      await octokit.issues.createLabel({
        owner: repo.owner,
        repo: repo.name,
        name: spec.name,
        color: spec.color,
        ...(spec.description ? { description: spec.description } : {}),
      });
      result.created.push(spec.name);
    } catch (err: unknown) {
      if (isAlreadyExists(err)) {
        result.existed.push(spec.name);
        continue;
      }
      throw err;
    }
  }
  return result;
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: number }).status;
  if (status !== 422) return false;
  // GitHub returns 422 with errors[].code === 'already_exists' when label exists.
  const errors = (err as { response?: { data?: { errors?: Array<{ code?: string }> } } })
    .response?.data?.errors;
  if (!errors || errors.length === 0) return true;
  return errors.some((e) => e.code === 'already_exists');
}
