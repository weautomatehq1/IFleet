// Re-export shim (Phase 1a extraction, split lane T2). Body moved to
// @wahq/orchestrator-core/workers — this path is preserved so existing
// callers in src/ that import from './workers' continue to resolve.
export { createClaudeAdapter, type ClaudeAdapterOptions } from '@wahq/orchestrator-core/workers/claude';
export { createCodexAdapter, type CodexAdapterOptions } from '@wahq/orchestrator-core/workers/codex';
export * from '@wahq/orchestrator-core/workers/types';
