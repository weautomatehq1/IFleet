// Per-task routing modes — prompt templates and label/body detection.
//
// Each mode reshapes the architect's planning prompt to match a known operator
// workflow (ralph/ulw/tdd/deslop). The 'standard' mode is the no-op fall-through
// used when no explicit `mode:*` label is present and the auto-router is below
// its confidence threshold. Pipeline consumers (architect.ts) read the prompt
// via `getModePrompt` so the mapping lives in one place.

import type { SprintMode } from '../orchestrator/types.ts';

export type { SprintMode };

export const SPRINT_MODES: readonly SprintMode[] = [
  'standard',
  'ralph',
  'ulw',
  'tdd',
  'deslop',
] as const;

export const DEFAULT_MODE: SprintMode = 'standard';

const STANDARD_PROMPT = `You are the architect for an autonomous fleet sprint. \
Read the brief, plan the smallest diff that satisfies the acceptance criteria, \
and list the files you will touch. Prefer existing patterns over new abstractions. \
Surface risks and ambiguities up front so the editor does not have to guess.`;

const RALPH_PROMPT = `You are the architect in RALPH (persistence) mode. \
Plan a fix that keeps retrying — each editor pass narrows the failure surface \
until verify (typecheck + lint + test) goes green. List the smallest verifiable \
step first, then a fallback if step 1 fails. Do not stop at the first plausible \
fix; enumerate the next two retries the editor should try if the verify fails.`;

const ULW_PROMPT = `You are the architect in ULW (ultrawork) mode. \
The task spans multiple files. Plan a parallel-safe edit set: group files by \
independence so the editor can write them without ordering hazards. Call out \
shared types/interfaces first, then leaf files. Flag any cross-file invariants \
that the reviewer must verify. Keep the plan terse — one bullet per file.`;

const TDD_PROMPT = `You are the architect in TDD mode. \
Tests come first. Plan the test file(s) you will write before any production \
code change — list exact assertions, then the production change that will make \
them pass. The editor will write tests first, run them to confirm they fail, \
then implement. Do not propose any production edit without a paired failing test.`;

const DESLOP_PROMPT = `You are the architect in DESLOP mode. \
The target code is AI-generated boilerplate (dead exports, redundant comments, \
defensive validation for impossible inputs, premature abstractions). Plan a \
deletion-heavy diff that conforms the code to repo conventions. Each removal \
must cite the rule it enforces (e.g. "no commented-out code", "no fallback for \
internal callers"). Net lines should decrease.`;

const PROMPTS: Record<SprintMode, string> = {
  standard: STANDARD_PROMPT,
  ralph: RALPH_PROMPT,
  ulw: ULW_PROMPT,
  tdd: TDD_PROMPT,
  deslop: DESLOP_PROMPT,
};

export function getModePrompt(mode: SprintMode | null | undefined): string {
  if (!mode) return PROMPTS[DEFAULT_MODE];
  return PROMPTS[mode] ?? PROMPTS[DEFAULT_MODE];
}

export function isSprintMode(value: unknown): value is SprintMode {
  return typeof value === 'string' && (SPRINT_MODES as readonly string[]).includes(value);
}

/**
 * Detect a `mode:*` directive in any of:
 *  - GitHub labels: `mode:ralph`
 *  - Brief body header line: `mode: ralph` (case-insensitive)
 *  - Discord brief prefix: `/ralph ...` at the start of the body
 *
 * Returns the parsed mode or undefined. Used by `classifyTask` as the
 * deterministic override that beats the Haiku auto-router.
 */
export function detectExplicitMode(input: {
  labels: readonly string[];
  body: string;
}): SprintMode | undefined {
  for (const raw of input.labels) {
    const label = raw.toLowerCase().trim();
    const colon = label.indexOf(':');
    if (colon === -1) continue;
    if (label.slice(0, colon) !== 'mode') continue;
    const value = label.slice(colon + 1).trim();
    if (isSprintMode(value)) return value;
  }

  const headerMatch = input.body.match(/^\s*mode\s*:\s*([a-z]+)\s*$/im);
  if (headerMatch && headerMatch[1]) {
    const value = headerMatch[1].toLowerCase();
    if (isSprintMode(value)) return value;
  }

  const slashMatch = input.body.match(/^\s*\/([a-z]+)\b/i);
  if (slashMatch && slashMatch[1]) {
    const value = slashMatch[1].toLowerCase();
    if (isSprintMode(value)) return value;
  }

  return undefined;
}

// Sanity invariant — keeps prompts under the 500-char budget so they fit
// within the 2000-char HAIKU_MAX_OUTPUT_CHARS classifier window alongside
// the task title. See docs/MODEL-ROUTING.md §Mode overrides.
// Runs once at module load; cheap and fails loud.
for (const [mode, prompt] of Object.entries(PROMPTS)) {
  if (prompt.length >= 500) {
    throw new Error(
      `mode prompt ${mode} exceeds 500 chars (${prompt.length}); ` +
      `trim it to leave room for the task title in the classifier window`,
    );
  }
}

export const _internal = {
  PROMPTS,
  STANDARD_PROMPT,
  RALPH_PROMPT,
  ULW_PROMPT,
  TDD_PROMPT,
  DESLOP_PROMPT,
};
