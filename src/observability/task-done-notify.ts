import { spawn } from 'node:child_process';
import { request } from 'node:https';

export interface TaskDoneNotifyOpts {
  taskId: string;
  prUrl: string | undefined;
  brief: string;
  webhookUrl: string | undefined;
  claudePath: string;
}

const SUMMARY_PROMPT = (brief: string, prUrl: string): string =>
  `You are IFleet's reporter. A task just completed and a PR was opened.\n\n` +
  `Task brief:\n${brief}\n\nPR: ${prUrl}\n\n` +
  `Write exactly 2 sentences in plain English summarising what was accomplished. ` +
  `No technical jargon. No markdown. No bullet points. ` +
  `Start the first sentence with "IFleet just finished".`;

function runClaude(claudePath: string, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(claudePath, ['-p', prompt, '--dangerously-skip-permissions'], {
      env: { ...process.env },
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
    const summary = await runClaude(claudePath, SUMMARY_PROMPT(brief, prUrl));
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
