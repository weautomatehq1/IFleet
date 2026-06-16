// M6-T3 — Known model arms for the shadow-eval bandit.
//
// Replicated from `src/orchestrator/handlers/boot-config.ts:18-23` to avoid
// a cross-module import that drags daemon-boot wiring into the routing call
// site. The boot-config copy is the canonical bootstrap-time check; this
// copy is the routing-time arm universe. Keep them in sync — adding a new
// model to either list without the other will not break compile, only
// shadow-eval coverage.
//
// Full model IDs only (no shorthands). `RoutingDecision.architect.model`
// in `src/pipeline/factory.ts` comes from `mapModel(...)` which always
// emits the full id form.

export const KNOWN_MODEL_IDS: readonly string[] = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];
