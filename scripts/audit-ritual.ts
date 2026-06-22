// PM2 cron entry-point for scheduled audit runs.
// Reads AUDIT_MODE ('autopilot' | 'morning-report') and AUDIT_REPOS (comma-separated).
//
// autopilot:      spawns `claude -p /audit-fix auto` inside each repo checkout
// morning-report: reads each repo's .audits/index.json and posts a findings
//                 summary to #ifleet (channel 1504120127791042631)

import { execFile, execSync } from 'node:child_process';
import { isMainModule } from './lib/is-main-module.js';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import type { TextChannel } from 'discord.js';
import {
  resolveAuditIndexPath,
  readAuditIndex,
  markFindingsClosed,
  openFindings,
} from '../src/discord/audit-runner.js';
import { isTerminalAuditStatus } from '../src/audit/types.js';

const execFileAsync = promisify(execFile);

const IFLEET_CHANNEL_ID = '1504120127791042631';
const AUDIT_MODE = process.env['AUDIT_MODE'] ?? 'morning-report';
const AUDIT_REPOS = (process.env['AUDIT_REPOS'] ?? 'IFleet')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

// Short repo name → full GitHub "org/repo" path.
// If the entry already contains a slash it is used verbatim.
const GITHUB_ORG = process.env['GITHUB_ORG'] ?? 'weautomatehq1';
function toGitHubRepo(repo: string): string {
  return repo.includes('/') ? repo : `${GITHUB_ORG}/${repo}`;
}

// Matches canonical audit finding IDs: AUDIT-<Repo>-<8hexchars>
export const AUDIT_ID_RE = /\bAUDIT-[A-Za-z][A-Za-z0-9]*-[0-9a-f]{8}\b/g;

// Lazily resolved at first call — keeps the module importable even when the
// claude binary isn't on PATH (e.g. test environments, import-time analysis).
function resolveClaude(): string {
  if (process.env['CLAUDE_BIN']) return process.env['CLAUDE_BIN'];
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    // VPS default: deploy/install-vps.sh symlinks claude to /usr/local/bin/claude.
    return '/usr/local/bin/claude';
  }
}

// Repos are expected to be siblings of the IFleet checkout.
// IFleet itself resolves to IFLEET_REPO_ROOT (or cwd) to avoid duplication.
export function resolveRepoPath(repo: string): string {
  const ifleetRoot = process.env['IFLEET_REPO_ROOT'] ?? process.cwd();
  if (repo === 'IFleet') return ifleetRoot;
  const base = process.env['AUDIT_BASE_DIR'] ?? resolve(ifleetRoot, '..');
  return resolve(base, repo);
}

// ---------------------------------------------------------------------------
// PR reconciliation — mark findings fixed when their PR has been merged
// ---------------------------------------------------------------------------

/**
 * For each repo, fetch its own merged PRs from the last 30 days, extract any
 * AUDIT-* IDs referenced in titles/bodies, and mark those findings as `fixed`
 * in that repo's local index.json. Syncs to Supabase afterwards if
 * IFLEET_KG_DATABASE_URL is set.
 *
 * The gh query is scoped per-repo so that a PR in repo A never closes a
 * finding that belongs to repo B.
 */
export async function reconcileMergedPRs(repos: string[]): Promise<void> {
  const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const repo of repos) {
    const ghRepo = toGitHubRepo(repo);
    let prJson: string;
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'list',
        '--repo', ghRepo,
        '--state', 'merged',
        '--search', `is:pr is:merged merged:>=${sinceDate}`,
        '--limit', '200',
        '--json', 'number,title,body,mergedAt,url',
      ]);
      prJson = stdout;
    } catch (err) {
      console.warn(
        `[audit-ritual] reconcile: gh pr list failed for ${ghRepo} —`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    let prs: { number: number; title: string; body: string; mergedAt: string; url: string }[];
    try {
      prs = JSON.parse(prJson) as typeof prs;
    } catch {
      console.warn(`[audit-ritual] reconcile: failed to parse gh output for ${ghRepo}`);
      continue;
    }

    if (prs.length === 0) continue;

    const closedByPr = new Map<string, { url: string; mergedAt: string }>();
    for (const pr of prs) {
      const text = `${pr.title}\n${pr.body ?? ''}`;
      for (const id of text.match(AUDIT_ID_RE) ?? []) {
        if (!closedByPr.has(id)) {
          closedByPr.set(id, { url: pr.url, mergedAt: pr.mergedAt });
        }
      }
    }

    if (closedByPr.size === 0) continue;

    const repoPath = resolveRepoPath(repo);
    const indexPath = resolveAuditIndexPath(repoPath);
    const index = readAuditIndex(indexPath);
    if (!index) continue;

    // Collect PR-references into a batch so the index + closed.json get one
    // write each (versus N writes through markFindingClosed). Reconciled
    // closures are status:'fixed' — a real merged PR did the work — and
    // closed_at is the PR's mergedAt so the audit timeline matches GitHub.
    const toClose: Array<{
      findingId: string;
      prUrl: string;
      closedAt: string;
      status: 'fixed';
    }> = [];
    for (const finding of index.findings) {
      if (isTerminalAuditStatus(finding.status)) continue;
      const pr = closedByPr.get(finding.id);
      if (!pr) continue;
      toClose.push({
        findingId: finding.id,
        prUrl: pr.url,
        closedAt: pr.mergedAt,
        status: 'fixed',
      });
    }

    const changed = toClose.length > 0 ? markFindingsClosed(indexPath, toClose) : 0;

    if (changed > 0) {
      console.log(`[audit-ritual] reconcile: ${repo} — marked ${changed} finding(s) fixed`);

      if (process.env['IFLEET_KG_DATABASE_URL']) {
        try {
          await execFileAsync('npx', ['tsx', 'scripts/sync-audit-findings.ts', indexPath], {
            cwd: resolveRepoPath('IFleet'),
          });
        } catch (syncErr) {
          console.warn(
            `[audit-ritual] reconcile: Supabase sync failed for ${repo}:`,
            syncErr instanceof Error ? syncErr.message : String(syncErr),
          );
        }
      }
    }
  }
}

async function runAutopilot(repos: string[]): Promise<void> {
  for (const repo of repos) {
    const cwd = resolveRepoPath(repo);
    console.log(`[audit-ritual] autopilot ${repo} → ${cwd}`);
    try {
      await execFileAsync(resolveClaude(), ['-p', '/audit-fix auto'], {
        cwd,
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
      console.log(`[audit-ritual] autopilot done: ${repo}`);
    } catch (err) {
      console.error(
        `[audit-ritual] autopilot failed: ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function runMorningReport(repos: string[]): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) throw new Error('[audit-ritual] DISCORD_BOT_TOKEN not set');

  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`**Audit morning report — ${date}**`, ''];

  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo);
    const indexPath = resolveAuditIndexPath(repoPath);
    const index = readAuditIndex(indexPath);
    if (!index) {
      lines.push(`**${repo}** — no findings index (run /audit-scan first)`);
      continue;
    }
    const open = openFindings(index);
    const sev = index.by_severity;
    const inProgress = index.findings.filter(
      (f) => f.status === 'fixing' || f.status === 'verifying',
    ).length;
    const inProgressStr = inProgress > 0 ? `, ${inProgress} in-progress` : '';
    lines.push(
      `**${repo}** — ${open.length} open${inProgressStr}` +
        ` (CRITICAL: ${sev['CRITICAL'] ?? 0}` +
        `, IMPORTANT: ${sev['IMPORTANT'] ?? 0}` +
        `, COSMETIC: ${sev['COSMETIC'] ?? 0})`,
    );
  }

  const message = lines.join('\n');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const DISCORD_TIMEOUT_MS = 30_000;
  let loginTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        loginTimer = setTimeout(
          () => reject(new Error('[audit-ritual] Discord login timed out after 30s')),
          DISCORD_TIMEOUT_MS,
        );
      }),
      (async () => {
        await client.login(token);
        await new Promise<void>((res, rej) => {
          client.once('ready', async () => {
            try {
              const channel = await client.channels.fetch(IFLEET_CHANNEL_ID);
              if (!channel || !('send' in channel)) {
                throw new Error(`channel ${IFLEET_CHANNEL_ID} is not a text channel`);
              }
              await (channel as TextChannel).send(message);
              res();
            } catch (err) {
              rej(err);
            }
          });
        });
      })(),
    ]);
  } finally {
    clearTimeout(loginTimer);
    client.destroy();
  }
  console.log('[audit-ritual] morning report posted');
}

async function main(): Promise<void> {
  console.log(`[audit-ritual] mode=${AUDIT_MODE} repos=${AUDIT_REPOS.join(',')}`);
  // Always reconcile first so merged PRs are reflected before we report or fix.
  await reconcileMergedPRs(AUDIT_REPOS);
  if (AUDIT_MODE === 'autopilot') {
    await runAutopilot(AUDIT_REPOS);
  } else {
    await runMorningReport(AUDIT_REPOS);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[audit-ritual] fatal:', err);
    process.exit(1);
  });
}
