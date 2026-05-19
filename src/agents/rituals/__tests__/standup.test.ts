import { describe, expect, it } from 'vitest';
import { formatStandup } from '../standup.js';

const BASE = {
  date: '2026-05-20',
  tasksCompleted: 3,
  tasksFailed: 0,
  verifierPassRate: '89%',
  costUsd: '$4.30',
  pm2Restarts: 0,
  pm2Uptime: '12h0m',
  blockers: [],
};

describe('formatStandup', () => {
  it('includes the date in the header', () => {
    const out = formatStandup(BASE);
    expect(out).toContain('2026-05-20');
  });

  it('shows task counts when non-zero', () => {
    const out = formatStandup(BASE);
    expect(out).toContain('Tasks completed: 3');
  });

  it('shows slow-day message when zero tasks', () => {
    const out = formatStandup({ ...BASE, tasksCompleted: 0, tasksFailed: 0 });
    expect(out).toContain('Slow day');
  });

  it('shows verifier pass rate', () => {
    const out = formatStandup(BASE);
    expect(out).toContain('89%');
  });

  it('shows cost', () => {
    const out = formatStandup(BASE);
    expect(out).toContain('$4.30');
  });

  it('omits blockers section when empty', () => {
    const out = formatStandup(BASE);
    expect(out).not.toContain('Blockers:');
  });

  it('includes blockers when present', () => {
    const out = formatStandup({
      ...BASE,
      blockers: ['Postgres not provisioned — blocking M3.W1'],
    });
    expect(out).toContain('Blockers:');
    expect(out).toContain('Postgres not provisioned');
  });

  it('does not contain flattery phrases', () => {
    const out = formatStandup(BASE);
    expect(out.toLowerCase()).not.toMatch(/great work|exciting progress|excellent|wonderful/);
  });

  it('shows uptime restarts when non-zero', () => {
    const out = formatStandup({ ...BASE, pm2Restarts: 2, pm2Uptime: '4h30m' });
    expect(out).toContain('2 restarts');
  });
});
