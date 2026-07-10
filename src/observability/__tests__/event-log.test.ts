import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileEventLog, parseEvents } from '@wahq/orchestrator-core/observability/event-log';
import type { Event } from '@wahq/orchestrator-core/observability/types';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'omc-events-'));
}

describe('FileEventLog', () => {
  it('appends and reads events as JSONL round-trip', () => {
    const log = new FileEventLog({ rootDir: tmpRoot() });
    const a: Event = { ts: 1, sprintId: 's1', kind: 'task.start', payload: { x: 1 } };
    const b: Event = {
      ts: 2,
      sprintId: 's1',
      taskId: 't1',
      workerId: 'w1',
      kind: 'task.done',
      payload: { result: 'ok' },
    };
    log.append(a);
    log.append(b);
    const read = log.read('s1');
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(a);
    expect(read[1]).toEqual(b);
  });

  it('returns empty array for an unknown sprint', () => {
    const log = new FileEventLog({ rootDir: tmpRoot() });
    expect(log.read('does-not-exist')).toEqual([]);
  });

  it('isolates events between sprints', () => {
    const log = new FileEventLog({ rootDir: tmpRoot() });
    log.append({ ts: 1, sprintId: 'a', kind: 'k', payload: {} });
    log.append({ ts: 2, sprintId: 'b', kind: 'k', payload: {} });
    expect(log.read('a')).toHaveLength(1);
    expect(log.read('b')).toHaveLength(1);
  });

  it('tail yields appended events and supports fromTs filter', async () => {
    const log = new FileEventLog({ rootDir: tmpRoot() });
    log.append({ ts: 1, sprintId: 'tail', kind: 'old', payload: {} });
    log.append({ ts: 100, sprintId: 'tail', kind: 'new1', payload: {} });

    const iter = log.tail('tail', { fromTs: 50 })[Symbol.asyncIterator]();
    // Append more events asynchronously
    setTimeout(() => {
      log.append({ ts: 200, sprintId: 'tail', kind: 'new2', payload: {} });
    }, 50);

    const events: Event[] = [];
    const deadline = Date.now() + 4000;
    while (events.length < 2 && Date.now() < deadline) {
      const next = await Promise.race([
        iter.next(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 500),
        ),
      ]);
      if (next.done) continue;
      events.push(next.value as Event);
    }

    expect(events.map((e) => e.kind)).toEqual(['new1', 'new2']);
    await iter.return?.();
  });

  // Durability: the JSONL store is line-oriented, so a partial write (e.g.
  // process killed mid-append) must leave previously-written lines parseable
  // and must not poison subsequent reads.
  it('recovers cleanly when the last line is truncated (crash mid-write)', () => {
    const root = tmpRoot();
    const log = new FileEventLog({ rootDir: root });
    const good: Event = { ts: 1, sprintId: 'crash', kind: 'task.start', payload: { ok: 1 } };
    log.append(good);

    // Simulate a torn write: open the underlying file directly and append a
    // half-line (no trailing newline). This is what `kill -9` mid-write
    // produces on the filesystem.
    const file = log.sprintFile('crash');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, '{"ts":2,"sprintId":"crash","kind":"task.do', 'utf8');

    const recovered = log.read('crash');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(good);

    // And a subsequent successful append still reads back correctly. The
    // half-line stays orphaned but is silently skipped; the new event lands
    // on its own line.
    const after: Event = { ts: 3, sprintId: 'crash', kind: 'task.done', payload: {} };
    log.append(after);
    const final = log.read('crash');
    expect(final.map((e) => e.ts)).toEqual([1, 3]);
  });

  it('parseEvents skips malformed lines without throwing', () => {
    const raw = [
      JSON.stringify({ ts: 1, sprintId: 's', kind: 'a', payload: {} }),
      'not-json',
      '',
      '{"ts":2,"partial":',
      JSON.stringify({ ts: 3, sprintId: 's', kind: 'b', payload: {} }),
    ].join('\n');
    const events = parseEvents(raw);
    expect(events.map((e) => e.ts)).toEqual([1, 3]);
  });
});
