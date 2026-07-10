// @wahq/orchestrator-core — shared orchestration engine.
//
// The queue engine + its contract/type root was extracted here (BUILD-PLAN T2,
// split lane T3). Core owns exactly the queue store (4 tables: tasks,
// pr_decisions, nonce_ledger, discord_outbox), the contract/routing type root,
// the control plane, the unified adapter, the Discord ingest source, and the
// shared leaves (hmac, discord-outbox, ulid, audit-finding).
//
// Consumers may import from this barrel OR from the granular subpath exports
// (e.g. `@wahq/orchestrator-core/queue/store`). The two names that differ
// between the unified contract and the legacy GitHub queue — `QueuedTask` and
// `TaskSource` — are exported here in their unified (contracts) form; the
// legacy shapes stay subpath-only (`.../queue/types`, `.../queue/sources/base`).

// --- contract / routing type root ---
export * from './contracts/routing.js';
export * from './contracts/hmac.js';
export * from './contracts/discord-out.js';
export * from './contracts/channel-router.js';
export { isDiscordSource, isGitHubSource } from './contracts/task.js';
export type { TaskState, QueuedTask, TaskSource } from './contracts/task.js';

// --- queue engine ---
export * from './queue/store.js';
export * from './queue/config.js';
export * from './queue/control-plane.js';
export * from './queue/unified-adapter.js';
export { DiscordSource, idempotencyForDiscord } from './queue/sources/discord.js';
export type { DiscordIngestCommand, DiscordSourceOptions } from './queue/sources/discord.js';
export type { TaskSource as QueueTaskSource } from './queue/sources/base.js';
// queue/types: adapter + label constants. Its legacy `QueuedTask` and its
// re-exported RoutingHints/VerifyKind are intentionally omitted here (the
// unified QueuedTask above and contracts/routing are canonical).
export type { QueueAdapter, PickOpts, TaskStatus, RepoRef, RepoConfig } from './queue/types.js';
export {
  LABEL_AUTO_SHIP,
  LABEL_IN_FLIGHT,
  LABEL_SHIPPED,
  LABEL_FAILED,
  LABEL_CAPABILITY_BLOCKED,
  LABEL_IFLEET_IN_PROGRESS,
  LABEL_IFLEET_DONE,
  LABEL_IFLEET_COOLDOWN,
  LABEL_IFLEET_CHRONIC_FAIL,
  LABEL_RETRY_PREFIX,
  COOLDOWN_MS,
  MAX_AUTO_RETRIES,
} from './queue/types.js';

// --- shared leaves ---
export * from './observability/discord-outbox.js';
export * from './utils/ulid.js';
export * from './utils/audit-finding.js';
