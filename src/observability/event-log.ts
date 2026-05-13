import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Event, EventLog, TailOptions } from './types.js';

const POLL_INTERVAL_MS = 250;

export interface FileEventLogOptions {
  rootDir?: string;
}

export class FileEventLog implements EventLog {
  private readonly rootDir: string;

  constructor(opts: FileEventLogOptions = {}) {
    this.rootDir = opts.rootDir ?? resolve(process.cwd(), '.omc/sprints');
  }

  sprintFile(sprintId: string): string {
    return resolve(this.rootDir, sprintId, 'events.jsonl');
  }

  private ensureDir(file: string): void {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(event: Event): void {
    const file = this.sprintFile(event.sprintId);
    this.ensureDir(file);
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  }

  read(sprintId: string): Event[] {
    const file = this.sprintFile(sprintId);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    return parseEvents(raw);
  }

  tail(sprintId: string, opts: TailOptions = {}): AsyncIterable<Event> {
    const file = this.sprintFile(sprintId);
    this.ensureDir(file);
    return tailFile(file, opts);
  }
}

export function parseEvents(raw: string): Event[] {
  if (!raw) return [];
  const events: Event[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

async function* tailFile(file: string, opts: TailOptions): AsyncIterable<Event> {
  if (!existsSync(file)) {
    appendFileSync(file, '', 'utf8');
  }

  const fromTs = opts.fromTs ?? 0;
  let handle: FileHandle | null = null;
  let position = 0;
  let buffer = '';
  let watcher: FSWatcher | null = null;
  let pendingResolver: (() => void) | null = null;
  let closed = false;

  const wake = (): void => {
    if (pendingResolver) {
      const r = pendingResolver;
      pendingResolver = null;
      r();
    }
  };

  try {
    handle = await open(file, 'r');
    watcher = watch(file, { persistent: false }, () => wake());
    const pollTimer = setInterval(wake, POLL_INTERVAL_MS);

    try {
      while (!closed) {
        const stat = await handle.stat();
        if (stat.size > position) {
          const length = stat.size - position;
          const data = Buffer.alloc(length);
          await handle.read(data, 0, length, position);
          position = stat.size;
          buffer += data.toString('utf8');

          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf('\n');
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Event;
              if (event.ts >= fromTs) yield event;
            } catch {
              // skip
            }
          }
        }

        await new Promise<void>((resolverFn) => {
          pendingResolver = resolverFn;
        });
      }
    } finally {
      clearInterval(pollTimer);
    }
  } finally {
    closed = true;
    watcher?.close();
    if (handle) await handle.close();
  }
}
