import type { RoutingHints, VerifyKind } from './types.js';

const MODELS = new Set(['opus', 'sonnet', 'haiku', 'codex'] as const);
const PRIORITIES = new Set(['low', 'normal', 'high'] as const);

type Model = NonNullable<RoutingHints['model']>;
type Priority = RoutingHints['priority'];

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

function mergeVerify(current: VerifyKind[] | undefined, additions: VerifyKind[]): VerifyKind[] {
  const next = current ? [...current] : [];
  for (const kind of additions) {
    if (!next.includes(kind)) next.push(kind);
  }
  return next;
}
