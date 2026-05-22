import { SlashCommandBuilder, type SlashCommandOptionsOnlyBuilder } from 'discord.js';

export const SLASH_COMMAND_NAMES = ['ship', 'plan', 'status', 'cancel', 'approve', 'verify', 'audit', 'audit-fix', 'audit-autopilot', 'audit-status'] as const;
export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

/** Returned builders always have at least one option, hence the union. */
export type SlashCommandDef = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

export function buildSlashCommands(): SlashCommandDef[] {
  return [
    new SlashCommandBuilder()
      .setName('ship')
      .setDescription('Ship a feature — runs the full pipeline and opens a PR.')
      .addStringOption((o) =>
        o
          .setName('prompt')
          .setDescription('What to build (free-form brief).')
          .setRequired(true)
          .setMaxLength(1900),
      ),
    new SlashCommandBuilder()
      .setName('plan')
      .setDescription('Plan a feature — pipeline stops after architect plan, waits for HITL approval.')
      .addStringOption((o) =>
        o
          .setName('prompt')
          .setDescription('What to plan (free-form brief).')
          .setRequired(true)
          .setMaxLength(1900),
      ),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show task status — current state of one task or the last 5 in this channel.')
      .addStringOption((o) =>
        o
          .setName('taskid')
          .setDescription('Optional task ID. Omit to see the last 5 tasks in this channel.')
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel an in-flight task.')
      .addStringOption((o) =>
        o.setName('taskid').setDescription('Task ID to cancel.').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Approve a paused plan and resume the pipeline.')
      .addStringOption((o) =>
        o.setName('taskid').setDescription('Task ID waiting at the HITL gate.').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Manually rerun the verifier for a task (sandbox build/typecheck/lint/test/invariants).')
      .addStringOption((o) =>
        o.setName('taskid').setDescription('Task ID to re-verify.').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('audit')
      .setDescription('Scan this channel\'s repo for code quality issues'),
    new SlashCommandBuilder()
      .setName('audit-fix')
      .setDescription('Fix CRITICAL findings in this channel\'s repo'),
    new SlashCommandBuilder()
      .setName('audit-autopilot')
      .setDescription('Fix ALL findings overnight — CRITICAL → IMPORTANT → COSMETIC'),
    new SlashCommandBuilder()
      .setName('audit-status')
      .setDescription('Show open finding counts for this channel\'s repo'),
  ];
}
