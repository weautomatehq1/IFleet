import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { claudeChildEnv, wrapBriefAsData } from '@wahq/orchestrator-core/workers/claude-env';

export interface TaskDoneNotifyOpts {
  taskId: string;
  prUrl: string | undefined;
  brief: string;
  webhookUrl: string | undefined;
  claudePath: string;
}

const SUMMARY_INSTRUCTION = (prUrl: string): string =>
  `You are IFleet's reporter. A task just completed and a PR was opened (PR: ${prUrl}).\n` +
  `Write exactly 2 sentences in plain English summarising what was accomplished. ` +
  `No technical jargon. No markdown. No bullet points. ` +
  `Start the first sentence with "IFleet just finished".`;

export function buildSummaryPrompt(brief: string, prUrl: string): string {
  return wrapBriefAsData(SUMMARY_INSTRUCTION(prUrl), brief);
}

export function buildSummaryArgs(prompt: string): string[] {
  // The summariser does not write files and only needs to read the prompt
  // it received. We deliberately omit `--dangerously-skip-permissions` and
  // restrict tools to nothing — the summary is produced by the model
  // itself, not by tool calls. If the prompt-injected brief later tries to
  // invoke a tool, Claude has no permitted tool to run.
  return [
    '-p',
    prompt,
    '--permission-mode',
    'default',
    '--allowedTools',
    '',
  ];
}

function runClaude(claudePath: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(claudePath, buildSummaryArgs(prompt), {
      env: claudeChildEnv(),
    });
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out.trim()));
    proc.on('error', () => resolve(''));
  });
}

function postWebhook(webhookUrl: string, content: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content });
    const url = new URL(webhookUrl);
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

export async function postTaskDoneNotification(opts: TaskDoneNotifyOpts): Promise<void> {
  const { taskId, prUrl, brief, webhookUrl, claudePath } = opts;
  if (!prUrl || !webhookUrl) return;

  try {
    const prompt = buildSummaryPrompt(brief, prUrl);
    const summary = await runClaude(claudePath, prompt);
    const lines: string[] = [
      `✅ **Done: \`${taskId}\`**`,
      `PR: ${prUrl}`,
    ];
    if (summary) lines.push('', summary);
    await postWebhook(webhookUrl, lines.join('\n'));
  } catch {
    // never let notification failures surface to the orchestrator
  }
}
