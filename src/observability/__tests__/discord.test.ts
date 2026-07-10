import { describe, it, expect } from 'vitest';
import {
  chunkLines,
  formatStatusCard,
  reduceEvents,
  createBufferedFormatter,
  DISCORD_CHUNK_LIMIT,
} from '@wahq/orchestrator-core/observability/discord';
import type { Event } from '@wahq/orchestrator-core/observability/types';

describe('chunkLines', () => {
  it('emits a single chunk when content fits the limit', () => {
    const chunks = chunkLines(['a', 'b', 'c'], 100);
    expect(chunks).toEqual(['a\nb\nc']);
  });

  it('splits across chunks under the limit', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${'x'.repeat(20)}`);
    const chunks = chunkLines(lines, 200);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('\n').split('\n')).toEqual(lines);
  });

  it('hard-splits a single oversized line', () => {
    const big = 'x'.repeat(500);
    const chunks = chunkLines([big], 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join('')).toBe(big);
  });
});

describe('reduceEvents', () => {
  it('tracks task lifecycle and rate-limit pressure', () => {
    const events: Event[] = [
      { ts: 1, sprintId: 's', kind: 'sprint.start', payload: { mode: 'autopilot' } },
      { ts: 2, sprintId: 's', taskId: 't1', workerId: 'w1', kind: 'task.picked', payload: { title: 'A' } },
      { ts: 3, sprintId: 's', taskId: 't1', workerId: 'w1', kind: 'task.done', payload: {} },
      { ts: 4, sprintId: 's', taskId: 't2', workerId: 'w1', kind: 'task.start', payload: { title: 'B' } },
      {
        ts: 5,
        sprintId: 's',
        workerId: 'w1',
        kind: 'worker.rateLimit',
        payload: { remaining: 5, limit: 100 },
      },
    ];
    const state = reduceEvents('s', events);
    expect(state.mode).toBe('autopilot');
    expect(state.tasks.get('t1')?.status).toBe('done');
    expect(state.tasks.get('t2')?.status).toBe('in_flight');
    expect(state.rateLimits.get('w1')?.pressure).toBe('high');
  });
});

describe('formatStatusCard', () => {
  it('chunks large payloads into under-limit Discord messages', () => {
    const events: Event[] = [];
    for (let i = 0; i < 200; i++) {
      events.push({
        ts: i,
        sprintId: 'big',
        taskId: `t${i}`,
        kind: 'task.done',
        payload: { title: `Task ${'x'.repeat(40)} ${i}` },
      });
    }
    const chunks = formatStatusCard('big', events);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_CHUNK_LIMIT);
    expect(chunks[0]).toMatch(/Sprint `big`/);
  });
});

describe('createBufferedFormatter', () => {
  it('emits chunks after the buffer window elapses', async () => {
    const emitted: string[][] = [];
    const fmt = createBufferedFormatter('s', (chunks) => emitted.push(chunks), 30);
    fmt.push({ ts: 1, sprintId: 's', kind: 'sprint.start', payload: {} });
    fmt.push({ ts: 2, sprintId: 's', taskId: 't1', kind: 'task.start', payload: {} });
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.length).toBeGreaterThan(0);
    fmt.close();
  });
});
