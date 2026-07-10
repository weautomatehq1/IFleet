#!/usr/bin/env node
/**
 * Post-sprint summary email.
 *
 * Reads the events.jsonl for a sprint and renders a Resend-friendly HTML
 * email containing:
 *   - PR list (from sprint.completed payload, PR #49)
 *   - total durationMs (sprint.completed payload, PR #49)
 *   - per-task failure breakdown (synthesised from task.failed events)
 *
 * Usage:
 *   RESEND_API_KEY=re_xxx node --import tsx scripts/smoke-email.ts \
 *     --sprint <sprintId>
 *
 *   # Test rendering without sending (no API key needed):
 *   node --import tsx scripts/smoke-email.ts --from-json fixtures/events.json --dry-render
 *
 *   # Send a synthetic hello-world (legacy behaviour) to verify Resend wiring:
 *   RESEND_API_KEY=re_xxx node --import tsx scripts/smoke-email.ts --hello
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sendEmail } from '../src/utils/email.js';
import { parseEvents } from '@wahq/orchestrator-core/observability/event-log';
import type { Event } from '@wahq/orchestrator-core/observability/types';

const DEFAULT_TO = 'weautomatehq1@gmail.com';
const DEFAULT_SPRINTS_DIR = resolve(process.cwd(), '.omc/sprints');

export interface SprintSummary {
  sprintId: string;
  durationMs: number;
  prs: string[];
  failures: Array<{ taskId: string; error: string; exitCode: number | null }>;
  completed: boolean;
}

export function summariseSprint(sprintId: string, events: Event[]): SprintSummary {
  const failures: SprintSummary['failures'] = [];
  let durationMs = 0;
  let prs: string[] = [];
  let completed = false;

  for (const evt of events) {
    if (evt.kind === 'sprint.completed') {
      completed = true;
      const payload = evt.payload;
      if (typeof payload.durationMs === 'number') durationMs = payload.durationMs;
      if (Array.isArray(payload.prs)) {
        prs = payload.prs.filter((p): p is string => typeof p === 'string');
      }
    } else if (evt.kind === 'task.failed') {
      const payload = evt.payload;
      const exit = payload.exitCode;
      failures.push({
        taskId: evt.taskId ?? '(unknown)',
        error: typeof payload.error === 'string' ? payload.error : '(no error)',
        exitCode: typeof exit === 'number' ? exit : null,
      });
    }
  }

  return { sprintId, durationMs, prs, failures, completed };
}

export function renderSprintEmail(summary: SprintSummary): { subject: string; html: string } {
  const durationSec = (summary.durationMs / 1000).toFixed(1);
  const status = summary.completed
    ? summary.failures.length === 0
      ? 'GREEN'
      : 'PARTIAL'
    : 'IN PROGRESS';
  const subject = `[IFleet] Sprint ${summary.sprintId} — ${status} (${summary.prs.length} PRs, ${durationSec}s)`;

  const prList =
    summary.prs.length === 0
      ? '<p><em>No PRs opened.</em></p>'
      : '<ul>' +
        summary.prs.map((pr) => `<li><a href="${escapeHtml(pr)}">${escapeHtml(pr)}</a></li>`).join('') +
        '</ul>';

  const failureList =
    summary.failures.length === 0
      ? '<p><em>No task failures.</em></p>'
      : '<ul>' +
        summary.failures
          .map(
            (f) =>
              `<li><code>${escapeHtml(f.taskId)}</code> — exit ${
                f.exitCode ?? 'n/a'
              }: ${escapeHtml(f.error)}</li>`,
          )
          .join('') +
        '</ul>';

  const html = `
    <h2>IFleet sprint summary</h2>
    <p><strong>Sprint:</strong> <code>${escapeHtml(summary.sprintId)}</code></p>
    <p><strong>Status:</strong> ${status}</p>
    <p><strong>Total duration:</strong> ${durationSec}s (${summary.durationMs}ms)</p>
    <h3>Pull requests (${summary.prs.length})</h3>
    ${prList}
    <h3>Failures (${summary.failures.length})</h3>
    ${failureList}
    <hr/>
    <p style="color:#888;font-size:12px">Rendered at ${new Date().toISOString()}</p>
  `;
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findLatestSprintDir(rootDir: string): string | null {
  if (!existsSync(rootDir)) return null;
  const entries = readdirSync(rootDir)
    .map((name) => ({ name, full: join(rootDir, name) }))
    .filter((e) => {
      try {
        return statSync(e.full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return entries[0]?.full ?? null;
}

function loadEventsFromSprint(sprintId: string): Event[] {
  const file = resolve(DEFAULT_SPRINTS_DIR, sprintId, 'events.jsonl');
  if (!existsSync(file)) throw new Error(`No events.jsonl at ${file}`);
  return parseEvents(readFileSync(file, 'utf8'));
}

function loadEventsFromJson(path: string): Event[] {
  const raw = readFileSync(resolve(path), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`--from-json file must contain a JSON array of events`);
  }
  return parsed as Event[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  // Legacy hello mode — just verify Resend wiring.
  if (args.includes('--hello')) {
    const { id } = await sendEmail({
      to: DEFAULT_TO,
      subject: 'IFleet smoke test — Resend wired',
      html: `<h2>Resend integration smoke test</h2><p>Sent at: ${new Date().toISOString()}</p>`,
    });
    console.log(`Sent — id: ${id}`);
    return;
  }

  const fromJson = get('--from-json');
  const sprintArg = get('--sprint');
  const dryRender = args.includes('--dry-render');
  const to = get('--to') ?? DEFAULT_TO;

  let events: Event[];
  let sprintId: string;
  if (fromJson) {
    events = loadEventsFromJson(fromJson);
    sprintId = sprintArg ?? events.find((e) => e.sprintId)?.sprintId ?? 'fixture';
  } else if (sprintArg) {
    sprintId = sprintArg;
    events = loadEventsFromSprint(sprintId);
  } else {
    const latest = findLatestSprintDir(DEFAULT_SPRINTS_DIR);
    if (!latest) {
      throw new Error(
        `No sprint provided and no sprints under ${DEFAULT_SPRINTS_DIR}. Pass --sprint <id> or --from-json <path>.`,
      );
    }
    sprintId = latest.split('/').pop() ?? 'unknown';
    events = parseEvents(readFileSync(join(latest, 'events.jsonl'), 'utf8'));
  }

  const summary = summariseSprint(sprintId, events);
  const { subject, html } = renderSprintEmail(summary);

  if (dryRender) {
    console.log(`Subject: ${subject}\n`);
    console.log(html);
    return;
  }

  const { id } = await sendEmail({ to, subject, html });
  console.log(`Sent — id: ${id} sprint=${sprintId} prs=${summary.prs.length} failures=${summary.failures.length}`);
}

// Only run main when invoked as a script, not when imported by tests.
const invokedAsScript = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error('[smoke-email] Fatal:', err);
    process.exitCode = 1;
  });
}
