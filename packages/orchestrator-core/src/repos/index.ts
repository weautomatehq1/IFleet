// Barrel for the @wahq/orchestrator-core/repos subpath export.
// Mirrors the pre-extraction src/repos/index.ts surface.
export { FileChannelRouter } from './router.js';
export type { FileChannelRouterOptions } from './router.js';
export { GitRepoManager } from './manager.js';
export type { RepoManager, GitRepoManagerOptions } from './manager.js';
export { RepoHealthChecker } from './health.js';
export type { RepoHealthResult } from './health.js';
export type { ChannelRoute, ChannelRouter } from '../contracts/channel-router.js';
