/**
 * Structured escalation message format.
 *
 * Used when two roles reach an impasse (e.g. Architect vs Plan-Reviewer).
 * Posts a structured @Sebastian ping rather than a flat "help" message.
 * Consumed by Plan-Reviewer in M2; the format is defined here so both
 * M1 (rituals) and M2 (plan-reviewer) share the same structure.
 */

export interface EscalationInput {
  /** IFleet task ID, e.g. "ifleet-2026-512" */
  taskId: string;
  /** Which attempt number, e.g. 2 */
  attempt: number;
  /** Max attempts before auto-cancel */
  maxAttempts: number;
  /** Role that proposed the change */
  proposingRole: string;
  /** What the proposing role wants to do */
  proposal: string;
  /** Role that blocked */
  blockingRole: string;
  /** Why the blocking role vetoed */
  veto: string;
  /**
   * Optional recommended resolution — IFleet's own read on how to unblock,
   * stated as a fact, not a plea.
   */
  recommendation?: string;
}

export interface EscalationMessage {
  /** Full message text ready to send to Discord */
  text: string;
  /** Button labels for the HITL approval gate */
  buttons: string[];
}

export function buildEscalationMessage(input: EscalationInput): EscalationMessage {
  const lines: string[] = [];

  lines.push(
    `@Sebastian — ${input.proposingRole} ↔ ${input.blockingRole} disagreement (taskId=${input.taskId}, attempt ${input.attempt}/${input.maxAttempts})`,
  );
  lines.push('');
  lines.push(`${input.proposingRole} proposes: ${input.proposal}`);
  lines.push(`${input.blockingRole} vetoes: ${input.veto}`);

  if (input.recommendation) {
    lines.push('');
    lines.push(`IFleet recommends: ${input.recommendation}`);
  }

  return {
    text: lines.join('\n'),
    buttons: ['Approve revision', 'Block — needs ADR', 'Cancel task'],
  };
}

/** Renders the escalation as a formatted Discord message with button hints. */
export function formatEscalationForDiscord(input: EscalationInput): string {
  const msg = buildEscalationMessage(input);
  const buttonLine = `\n\n[${msg.buttons.join('] [')}]`;
  return msg.text + buttonLine;
}
