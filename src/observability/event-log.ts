import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
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
    // Tear-safe append: if the previous write was killed mid-line (no trailing
    // newline), prepend a `\n` so we don't merge the orphaned line with the
    // new event and corrupt both. The empty line is silently skipped by
    // parseEvents.
    const leading = endsWithNewline(file) ? '' : '\n';
    appendFileSync(file, leading + JSON.stringify(event) + '\n', 'utf8');
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

function endsWithNewline(file: string): boolean {
  if (!existsSync(file)) return true; // a fresh file starts cleanly
  let fd = -1;
  try {
    const stats = statSync(file);
    if (stats.size === 0) return true;
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, stats.size - 1);
    return buf[0] === 0x0a; // '\n'
  } catch {
    return true; // be permissive: don't block writes on a stat failure
  } finally {
    if (fd !== -1) closeSync(fd);
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
