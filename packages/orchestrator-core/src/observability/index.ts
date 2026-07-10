export type { Event, EventLog, TailOptions } from './types.js';
export { FileEventLog, parseEvents } from './event-log.js';
export {
  formatStatusCard,
  chunkLines,
  reduceEvents,
  createBufferedFormatter,
  DISCORD_CHUNK_LIMIT,
  BUFFER_FLUSH_MS,
} from './discord.js';
export { parseArgs, helpText, formatEventLine } from './tail-cli.js';
