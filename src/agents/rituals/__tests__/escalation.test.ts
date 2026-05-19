import { describe, expect, it } from 'vitest';
import { buildEscalationMessage, formatEscalationForDiscord } from '../escalation.js';

const BASE = {
  taskId: 'ifleet-2026-512',
  attempt: 2,
  maxAttempts: 2,
  proposingRole: 'Architect',
  blockingRole: 'Plan-Reviewer',
  proposal: 'refactor src/orchestrator/sprint.ts to add new event type',
  veto: 'src/orchestrator/sprint.ts is in SECURITY.md protected paths',
} as const;

describe('buildEscalationMessage', () => {
  it('includes taskId, attempt, and roles in header', () => {
    const { text } = buildEscalationMessage(BASE);
    expect(text).toContain('ifleet-2026-512');
    expect(text).toContain('attempt 2/2');
    expect(text).toContain('Architect');
    expect(text).toContain('Plan-Reviewer');
  });

  it('includes proposal and veto verbatim', () => {
    const { text } = buildEscalationMessage(BASE);
    expect(text).toContain(BASE.proposal);
    expect(text).toContain(BASE.veto);
  });

  it('includes recommendation when provided', () => {
    const { text } = buildEscalationMessage({
      ...BASE,
      recommendation: "Add the event type in src/orchestrator/events/verifier.ts instead.",
    });
    expect(text).toContain('IFleet recommends:');
    expect(text).toContain('src/orchestrator/events/verifier.ts');
  });

  it('omits recommendation section when not provided', () => {
    const { text } = buildEscalationMessage(BASE);
    expect(text).not.toContain('IFleet recommends:');
  });

  it('returns the three standard buttons', () => {
    const { buttons } = buildEscalationMessage(BASE);
    expect(buttons).toEqual(['Approve revision', 'Block — needs ADR', 'Cancel task']);
  });
});

describe('formatEscalationForDiscord', () => {
  it('appends button labels in bracket format', () => {
    const out = formatEscalationForDiscord(BASE);
    expect(out).toContain('[Approve revision]');
    expect(out).toContain('[Block — needs ADR]');
    expect(out).toContain('[Cancel task]');
  });

  it('produces a non-empty string that starts with @Sebastian', () => {
    const out = formatEscalationForDiscord(BASE);
    expect(out.startsWith('@Sebastian')).toBe(true);
  });
});
