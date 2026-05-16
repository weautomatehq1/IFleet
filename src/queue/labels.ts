import type { Octokit } from '@octokit/rest';
import {
  LABEL_AUTO_SHIP,
  LABEL_CAPABILITY_BLOCKED,
  LABEL_FAILED,
  LABEL_IN_FLIGHT,
  LABEL_SHIPPED,
  type RepoRef,
  type RoutingHints,
  type SprintMode,
  type VerifyKind,
} from './types.js';

const MODELS = new Set(['opus', 'sonnet', 'haiku', 'codex'] as const);
const PRIORITIES = new Set(['low', 'normal', 'high'] as const);

type Model = NonNullable<RoutingHints['model']>;
type Priority = RoutingHints['priority'];

const MODES = new Set(['ralph', 'ulw', 'tdd', 'deslop'] as const);
const DEFAULT_VERIFY: VerifyKind[] = ['typecheck', 'lint', 'test'];

export function parseLabels(labels: readonly string[]): RoutingHints {
  let model: Model | undefined;
  let priority: Priority = 'normal';
  let autonomy: RoutingHints['autonomy'] = 'auto';
  let verifyOverride: VerifyKind[] | undefined;
  let verifyNone = false;

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
      case 'mode':
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

  const mode = parseSprintMode(labels);
  const hints: RoutingHints = { priority, verify, autonomy, mode };
  if (model !== undefined) hints.model = model;
  return hints;
}

export function parseSprintMode(labels: readonly string[]): SprintMode {
  for (const raw of labels) {
    const label = raw.toLowerCase().trim();
    const colon = label.indexOf(':');
    if (colon === -1) continue;
    const key = label.slice(0, colon);
    const value = label.slice(colon + 1);
    if (key === 'mode' && (MODES as Set<string>).has(value)) {
      return value as SprintMode;
    }
  }
  return 'default';
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
  { name: 'mode:ralph', color: '0075ca', description: 'Sprint mode: persistence (do not stop until complete)' },
  { name: 'mode:ulw', color: '0075ca', description: 'Sprint mode: speed (bullet-point plan, one change per commit)' },
  { name: 'mode:tdd', color: '0075ca', description: 'Sprint mode: test-first (failing tests before implementation)' },
  { name: 'mode:deslop', color: '0075ca', description: 'Sprint mode: cleanup (remove dead code, no new features)' },
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
