/**
 * Architect tool registry.
 *
 * Each architect tool lives in its own file next to this one. This index is
 * the single import surface the planner uses to discover available tools — a
 * future planner integration (M5+) will pass these handles into the spawn
 * worker's tool list. For now the registry is consumed only by tests.
 */
export { queryCodeGraph } from './query_code_graph.js';
export type {
  QueryCodeGraphInput,
  QueryCodeGraphResult,
  QueryCodeGraphDeps,
  CodeGraphNode,
  CodeGraphEdge,
  CrossRepoCandidate,
} from './query_code_graph.js';

export { getReviewerPrefs } from './get_reviewer_prefs.js';
export type {
  GetReviewerPrefsDeps,
  ReviewerCard,
} from './get_reviewer_prefs.js';

import { queryCodeGraph } from './query_code_graph.js';
import { getReviewerPrefs } from './get_reviewer_prefs.js';

/**
 * The set of architect tools currently registered. Order is stable so a
 * test that asserts the registry shape doesn't flake on import order.
 */
export const ARCHITECT_TOOLS = [
  { name: 'query_code_graph', fn: queryCodeGraph },
  { name: 'get_reviewer_prefs', fn: getReviewerPrefs },
] as const;

export type ArchitectToolName = (typeof ARCHITECT_TOOLS)[number]['name'];
