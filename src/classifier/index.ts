import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { RoutingDecision, WorkerSpec, Provider, VerifyKind } from '../pipeline/types.ts';
import { parseLabels } from '../queue/labels.ts';

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

interface PipelineDefaults {
  architect: { provider: string; model: string };
  editor: { provider: string; model: string };
}

interface RoutingConfig {
  rules: RoutingRule[];
  pipeline: PipelineDefaults;
}

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const config: RoutingConfig = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'config', 'routing.json'), 'utf-8'),
) as RoutingConfig;

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

export function classifyTask(task: ClassifyInput): RoutingDecision {
  const text = `${task.title} ${task.body}`.toLowerCase();
  const hints = parseLabels(task.labels);

  let matchedRule: RoutingRule | undefined;
  outer: for (const rule of config.rules) {
    if (rule.match.keywords) {
      for (const kw of rule.match.keywords) {
        if (text.includes(kw.toLowerCase())) {
          matchedRule = rule;
          break outer;
        }
      }
    }
  }

  const defaults = config.pipeline;
  let architectProvider = defaults.architect.provider;
  let architectModel = defaults.architect.model;
  let editorProvider = defaults.editor.provider;
  let editorModel = defaults.editor.model;

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

  const reviewerProvider: Provider = editorProvider === 'codex' ? 'claude' : 'codex';

  return {
    architect: makeSpec(architectProvider, architectModel, 'architect'),
    editor: makeSpec(editorProvider, editorModel, 'editor'),
    reviewer: makeSpec(reviewerProvider, architectModel, 'reviewer'),
    verify: hints.verify,
  };
}
