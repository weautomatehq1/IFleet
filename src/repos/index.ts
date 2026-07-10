// Re-export shim (Phase 1a extraction, split lane T2). Body moved to
// @wahq/orchestrator-core/repos — this path is preserved so existing
// callers in src/ that import from './repos' continue to resolve.
export { FileChannelRouter } from '@wahq/orchestrator-core/repos/router';
export type { FileChannelRouterOptions } from '@wahq/orchestrator-core/repos/router';
export { GitRepoManager } from '@wahq/orchestrator-core/repos/manager';
export type { RepoManager, GitRepoManagerOptions } from '@wahq/orchestrator-core/repos/manager';
export { RepoHealthChecker } from '@wahq/orchestrator-core/repos/health';
export type { RepoHealthResult } from '@wahq/orchestrator-core/repos/health';
export type { ChannelRoute, ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
