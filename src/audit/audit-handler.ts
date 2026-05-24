// Audit command handlers — invoked by the daemon ControlPlane hooks for
// /audit-status, /audit-scan, /audit-fix, /audit-autopilot.
//
// Each handler resolves repoPath from the originating Discord channelId via
// the ChannelRouter, posts progress directly to the channel (NOT a thread —
// these are repo-wide commands, not task-scoped), and shells out to the
// `claude` CLI inside the repo's worktree to run the heavy lifting.
//
// The on-disk schema for findings lives at <repoPath>/.audits/index.json —
// see ~/.claude/commands/audit-scan.md for the authoritative schema.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Client, TextChannel } from 'discord.js';
import type { ChannelRouter } from '../contracts/channel-router.js';

export interface AuditHandlerDeps {
  router: ChannelRouter;
  client: Client;
}

export interface AuditFinding {
  id: string;
  severity: 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';
  category: string;
  title: string;
  detail: string;
  file_globs: string[];
  fix_sketch: string;
  parallel_safe: boolean;
  fingerprint: string;
  status: 'open' | 'fixing' | 'verifying' | 'fixed' | 'closed' | 'reopened';
  opened_at: string;
  closed_at: string | null;
  closing_pr: string | null;
}

export interface AuditIndex {
  repo: string;
  last_updated: string;
  open_findings: number;
  by_severity: { CRITICAL: number; IMPORTANT: number; COSMETIC: number };
  findings: AuditFinding[];
}

interface RepoContext {
  repo: string;
  repoPath: string;
  channelId: string;
}

function resolveRepo(channelId: string | undefined, deps: AuditHandlerDeps): RepoContext | null {
  if (!channelId) return null;
  const route = deps.router.resolve(channelId);
  if (!route) return null;
  return { repo: route.repo, repoPath: route.workDir, channelId };
}

async function postToChannel(client: Client, channelId: string, content: string): Promise<void> {
  try {
    const ch = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!ch || typeof (ch as TextChannel).send !== 'function') {
      console.warn(`[audit-handler] channel ${channelId} not fetchable or not text`);
      return;
    }
    await ch.send(content);
  } catch (err) {
    console.warn(
      `[audit-handler] postToChannel failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readIndex(repoPath: string): Promise<AuditIndex | null> {
  try {
    const raw = await fs.readFile(join(repoPath, '.audits', 'index.json'), 'utf8');
    return JSON.parse(raw) as AuditIndex;
  } catch {
    return null;
  }
}

async function writeIndex(repoPath: string, index: AuditIndex): Promise<void> {
  await fs.mkdir(join(repoPath, '.audits'), { recursive: true });
  await fs.writeFile(
    join(repoPath, '.audits', 'index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
    'utf8',
  );
}

function recomputeRollup(index: AuditIndex): AuditIndex {
  const open = index.findings.filter(
    (f) => f.status === 'open' || f.status === 'fixing' || f.status === 'reopened',
  );
  index.open_findings = open.length;
  index.by_severity = {
    CRITICAL: open.filter((f) => f.severity === 'CRITICAL').length,
    IMPORTANT: open.filter((f) => f.severity === 'IMPORTANT').length,
    COSMETIC: open.filter((f) => f.severity === 'COSMETIC').length,
  };
  index.last_updated = new Date().toISOString();
  return index;
}

function resolveClaude(): string {
  // PM2 runs with a restricted PATH — use CLAUDE_BIN env or fall back to
  // the known absolute path on the VPS rather than relying on PATH lookup.
  return process.env['CLAUDE_BIN'] ?? '/usr/bin/claude';
}

function spawnClaude(slashCommand: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = resolveClaude();
    const child = spawn(bin, ['-p', slashCommand], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude exited with code ${code ?? 'null'}`));
    });
  });
}

export async function handleAuditStatus(
  channelId: string | undefined,
  deps: AuditHandlerDeps,
): Promise<void> {
  const ctx = resolveRepo(channelId, deps);
  if (!ctx) {
    console.warn('[audit-handler] handleAuditStatus: no repo context for channel', channelId);
    return;
  }
  const index = await readIndex(ctx.repoPath);
  if (!index) {
    await postToChannel(
      deps.client,
      ctx.channelId,
      `**Audit Status — ${ctx.repo}**\nNo findings yet — run /audit first`,
    );
    return;
  }
  const sev = index.by_severity ?? { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 };
  const lines = [
    `**Audit Status — ${ctx.repo}**`,
    `Open: ${index.open_findings} findings`,
    `• CRITICAL: ${sev.CRITICAL ?? 0}`,
    `• IMPORTANT: ${sev.IMPORTANT ?? 0}`,
    `• COSMETIC: ${sev.COSMETIC ?? 0}`,
    `Last scan: ${index.last_updated}`,
  ];
  await postToChannel(deps.client, ctx.channelId, lines.join('\n'));
}

export async function handleAuditScan(
  channelId: string | undefined,
  deps: AuditHandlerDeps,
): Promise<void> {
  const ctx = resolveRepo(channelId, deps);
  if (!ctx) {
    console.warn('[audit-handler] handleAuditScan: no repo context for channel', channelId);
    return;
  }
  await postToChannel(deps.client, ctx.channelId, `Running audit scan on ${ctx.repo}…`);
  try {
    await spawnClaude('/audit-scan', ctx.repoPath);
  } catch (err) {
    await postToChannel(
      deps.client,
      ctx.channelId,
      `Audit scan failed on ${ctx.repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const index = await readIndex(ctx.repoPath);
  if (!index) {
    await postToChannel(
      deps.client,
      ctx.channelId,
      `**Audit complete — ${ctx.repo}**\nNo index.json produced — the scan may have failed silently.`,
    );
    return;
  }
  const sev = index.by_severity ?? { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 };
  const lines = [
    `**Audit complete — ${ctx.repo}**`,
    `Found: ${index.open_findings} findings (${sev.CRITICAL ?? 0}C / ${sev.IMPORTANT ?? 0}I / ${sev.COSMETIC ?? 0}Cos)`,
    `Run /audit-fix to fix CRITICAL • /audit-autopilot for everything`,
  ];
  await postToChannel(deps.client, ctx.channelId, lines.join('\n'));
}

async function fixOne(
  finding: AuditFinding,
  ctx: RepoContext,
  _deps: AuditHandlerDeps,
): Promise<boolean> {
  const index = await readIndex(ctx.repoPath);
  if (index) {
    const target = index.findings.find((f) => f.id === finding.id);
    if (target) {
      target.status = 'fixing';
      await writeIndex(ctx.repoPath, recomputeRollup(index));
    }
  }
  try {
    await spawnClaude(`/audit-fix ${finding.id}`, ctx.repoPath);
    const post = await readIndex(ctx.repoPath);
    if (post) {
      const target = post.findings.find((f) => f.id === finding.id);
      if (target) {
        target.status = 'fixed';
        target.closed_at = new Date().toISOString();
        await writeIndex(ctx.repoPath, recomputeRollup(post));
      }
    }
    return true;
  } catch (err) {
    console.warn(
      `[audit-handler] fix failed for ${finding.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    const post = await readIndex(ctx.repoPath);
    if (post) {
      const target = post.findings.find((f) => f.id === finding.id);
      if (target && target.status === 'fixing') {
        target.status = 'open';
        await writeIndex(ctx.repoPath, recomputeRollup(post));
      }
    }
    return false;
  }
}

export async function handleAuditFix(
  channelId: string | undefined,
  deps: AuditHandlerDeps,
): Promise<void> {
  const ctx = resolveRepo(channelId, deps);
  if (!ctx) {
    console.warn('[audit-handler] handleAuditFix: no repo context for channel', channelId);
    return;
  }
  const index = await readIndex(ctx.repoPath);
  if (!index) {
    await postToChannel(deps.client, ctx.channelId, 'No audit findings yet — run /audit-scan first');
    return;
  }
  const targets = index.findings.filter(
    (f) => f.severity === 'CRITICAL' && (f.status === 'open' || f.status === 'reopened'),
  );
  if (targets.length === 0) {
    await postToChannel(deps.client, ctx.channelId, `No open CRITICAL findings — you're clean`);
    return;
  }
  await postToChannel(
    deps.client,
    ctx.channelId,
    `Fixing ${targets.length} CRITICAL finding(s) in ${ctx.repo}…`,
  );
  let fixed = 0;
  let failed = 0;
  for (const f of targets) {
    const ok = await fixOne(f, ctx, deps);
    if (ok) fixed += 1;
    else failed += 1;
  }
  await postToChannel(
    deps.client,
    ctx.channelId,
    `**Audit-fix complete — ${ctx.repo}**\nFixed: ${fixed} • Failed: ${failed}`,
  );
}

export async function handleAuditAutopilot(
  channelId: string | undefined,
  deps: AuditHandlerDeps,
): Promise<void> {
  const ctx = resolveRepo(channelId, deps);
  if (!ctx) {
    console.warn('[audit-handler] handleAuditAutopilot: no repo context for channel', channelId);
    return;
  }
  let index = await readIndex(ctx.repoPath);
  if (!index) {
    await postToChannel(
      deps.client,
      ctx.channelId,
      `No audit index found — running scan on ${ctx.repo} first…`,
    );
    try {
      await spawnClaude('/audit-scan', ctx.repoPath);
    } catch (err) {
      await postToChannel(
        deps.client,
        ctx.channelId,
        `Audit scan failed on ${ctx.repo}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    index = await readIndex(ctx.repoPath);
    if (!index) {
      await postToChannel(
        deps.client,
        ctx.channelId,
        `Audit scan produced no index for ${ctx.repo} — cannot proceed.`,
      );
      return;
    }
  }
  await postToChannel(
    deps.client,
    ctx.channelId,
    `**Autopilot starting — ${ctx.repo}**\nWill process CRITICAL → IMPORTANT → COSMETIC in order.`,
  );
  const tiers: Array<AuditFinding['severity']> = ['CRITICAL', 'IMPORTANT', 'COSMETIC'];
  let totalFixed = 0;
  let totalFailed = 0;
  for (const tier of tiers) {
    // Re-read each tier — fixes can mutate later findings via fingerprint dedup.
    const current = await readIndex(ctx.repoPath);
    if (!current) break;
    const targets = current.findings.filter(
      (f) => f.severity === tier && (f.status === 'open' || f.status === 'reopened'),
    );
    if (targets.length === 0) {
      await postToChannel(deps.client, ctx.channelId, `**${tier}**: nothing to do.`);
      continue;
    }
    await postToChannel(
      deps.client,
      ctx.channelId,
      `**${tier}**: processing ${targets.length} finding(s)…`,
    );
    let tierFixed = 0;
    let tierFailed = 0;
    for (const f of targets) {
      const ok = await fixOne(f, ctx, deps);
      if (ok) tierFixed += 1;
      else tierFailed += 1;
    }
    totalFixed += tierFixed;
    totalFailed += tierFailed;
    await postToChannel(
      deps.client,
      ctx.channelId,
      `**${tier} done**: ${tierFixed} fixed, ${tierFailed} failed`,
    );
  }
  await postToChannel(
    deps.client,
    ctx.channelId,
    `**Autopilot complete — ${ctx.repo}**\nFixed: ${totalFixed} • Failed: ${totalFailed}`,
  );
}
