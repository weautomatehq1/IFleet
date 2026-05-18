import { describe, it, expect } from 'vitest';
import { renderSprintEmail, summariseSprint } from '../smoke-email.js';
import type { Event } from '../../src/observability/types.js';

const SPRINT_ID = 'spr-test-001';

function evt(partial: Partial<Event> & { kind: string }): Event {
  return {
    ts: partial.ts ?? Date.now(),
    sprintId: partial.sprintId ?? SPRINT_ID,
    taskId: partial.taskId,
    workerId: partial.workerId,
    kind: partial.kind,
    payload: partial.payload ?? {},
  };
}

describe('summariseSprint', () => {
  it('extracts durationMs and prs from sprint.completed (PR #49 payload shape)', () => {
    const events: Event[] = [
      evt({
        kind: 'sprint.completed',
        payload: {
          from: 'running',
          to: 'completed',
          durationMs: 12_345,
          prs: ['https://github.com/foo/bar/pull/1', 'https://github.com/foo/bar/pull/2'],
        },
      }),
    ];
    const s = summariseSprint(SPRINT_ID, events);
    expect(s.completed).toBe(true);
    expect(s.durationMs).toBe(12_345);
    expect(s.prs).toEqual([
      'https://github.com/foo/bar/pull/1',
      'https://github.com/foo/bar/pull/2',
    ]);
    expect(s.failures).toHaveLength(0);
  });

  it('aggregates task.failed events into a failure breakdown', () => {
    const events: Event[] = [
      evt({ kind: 'sprint.created', payload: { taskCount: 2 } }),
      evt({
        taskId: 'tsk-1',
        kind: 'task.failed',
        payload: { exitCode: 1, error: 'editor crashed' },
      }),
      evt({
        taskId: 'tsk-2',
        kind: 'task.failed',
        payload: { exitCode: null, error: 'reviewer blocked' },
      }),
      evt({
        kind: 'sprint.completed',
        payload: { durationMs: 5000, prs: [] },
      }),
    ];
    const s = summariseSprint(SPRINT_ID, events);
    expect(s.failures).toHaveLength(2);
    expect(s.failures[0]).toEqual({ taskId: 'tsk-1', exitCode: 1, error: 'editor crashed' });
    expect(s.failures[1]).toEqual({ taskId: 'tsk-2', exitCode: null, error: 'reviewer blocked' });
  });

  it('returns completed=false when sprint never finished', () => {
    const s = summariseSprint(SPRINT_ID, [evt({ kind: 'sprint.created', payload: {} })]);
    expect(s.completed).toBe(false);
    expect(s.durationMs).toBe(0);
    expect(s.prs).toEqual([]);
  });
});

describe('renderSprintEmail', () => {
  it('includes PR list, duration, and failure breakdown in the HTML body', () => {
    const { subject, html } = renderSprintEmail({
      sprintId: SPRINT_ID,
      durationMs: 8_500,
      prs: ['https://github.com/foo/bar/pull/9'],
      failures: [{ taskId: 'tsk-x', exitCode: 2, error: 'verify gate failed: lint' }],
      completed: true,
    });
    expect(subject).toContain('PARTIAL');
    expect(subject).toContain('1 PRs');
    expect(subject).toContain('8.5s');
    expect(html).toContain('https://github.com/foo/bar/pull/9');
    expect(html).toContain('tsk-x');
    expect(html).toContain('verify gate failed: lint');
  });

  it('marks the email GREEN when there are no failures', () => {
    const { subject } = renderSprintEmail({
      sprintId: SPRINT_ID,
      durationMs: 1000,
      prs: ['https://github.com/foo/bar/pull/1'],
      failures: [],
      completed: true,
    });
    expect(subject).toContain('GREEN');
  });

  it('escapes HTML special characters in PR urls and error messages', () => {
    const { html } = renderSprintEmail({
      sprintId: SPRINT_ID,
      durationMs: 0,
      prs: ['https://example.com/?a=1&b=<script>'],
      failures: [{ taskId: '<x>', exitCode: 1, error: '"oops"' }],
      completed: true,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('&quot;oops&quot;');
  });
});
