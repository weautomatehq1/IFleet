// Re-export shim — implementation moved to @wahq/orchestrator-core/observability (Phase 1c).
// Existing callers are unaffected.
export type { Event, EventLog, TailOptions } from '@wahq/orchestrator-core/observability';
export { FileEventLog, parseEvents } from '@wahq/orchestrator-core/observability';
export {
  formatStatusCard,
  chunkLines,
  reduceEvents,
  createBufferedFormatter,
  DISCORD_CHUNK_LIMIT,
  BUFFER_FLUSH_MS,
} from '@wahq/orchestrator-core/observability';
export { parseArgs, helpText, formatEventLine } from '@wahq/orchestrator-core/observability';
