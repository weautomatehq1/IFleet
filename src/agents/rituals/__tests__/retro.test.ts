import { describe, expect, it } from 'vitest';
import { formatRetro } from '../retro.js';

const BASE: Parameters<typeof formatRetro>[0] = {
  weekStart: '2026-06-09',
  weekEnd: '2026-06-15',
  prVerdicts: { merged: 5, rejected: 1, abandoned: 2 },
  proposals: { proposed: 3, approved: 1, rejected: 1, pending: 1 },
  costUsd: '$24.10',
  pm2Uptime: '6h0m',
  pm2Restarts: 0,
};

describe('formatRetro', () => {
  it('empty week — renders zero PR counts and omits proposer queue section', () => {
    const out = formatRetro({
      ...BASE,
      prVerdicts: { merged: 0, rejected: 0, abandoned: 0 },
      proposals: { proposed: 0, approved: 0, rejected: 0, pending: 0 },
    });
    expect(out).toContain('Merged: 0 · Rejected: 0 · Abandoned: 0');
    expect(out).not.toContain('Proposer queue');
  });

  it('busy week — all sections present with counts correctly placed', () => {
    const out = formatRetro(BASE);
    expect(out).toContain('Merged: 5');
    expect(out).toContain('Rejected: 1');
    expect(out).toContain('Abandoned: 2');
    expect(out).toContain('Proposer queue');
    expect(out).toContain('Proposed: 3');
    expect(out).toContain('Approved: 1');
    expect(out).toContain('Pending: 1');
  });

  it('cost n/a renders cleanly', () => {
    const out = formatRetro({ ...BASE, costUsd: 'n/a' });
    expect(out).toContain('**Cost (7d):** n/a');
  });

  it('uptime with restarts renders count in parens', () => {
    const out = formatRetro({ ...BASE, pm2Restarts: 3, pm2Uptime: '2h30m' });
    expect(out).toContain('(3 restarts)');
    expect(out).toContain('2h30m');
  });

  it('no flattery phrases', () => {
    const out = formatRetro(BASE);
    expect(out.toLowerCase()).not.toMatch(/great|excellent|wonderful|exciting/);
  });

  it('header includes both weekStart and weekEnd', () => {
    const out = formatRetro(BASE);
    expect(out).toContain('2026-06-09');
    expect(out).toContain('2026-06-15');
  });
});
