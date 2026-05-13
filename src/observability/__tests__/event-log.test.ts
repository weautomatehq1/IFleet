import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventLog } from '../event-log.js';
import type { Event } from '../types.js';

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
});
