import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInteractionCreate } from '../handlers/interaction-create.js';
import type { ChannelRouter } from '@wahq/orchestrator-core/contracts/channel-router';
import type {
  ControlCommand,
  ControlPlaneClient,
} from '../../contracts/control-plane-client.js';

const CHAN = '1504120127791042631';
const USER = '1503477896402960405';

// Hosted in a mutable holder so each test can point the route at the
// per-test tmpdir that backs the .audits/index.json fixture.
const ROUTE_WORKDIR = { current: '/tmp/ifleet-wd' };

function route(channelId: string) {
  return channelId === CHAN
    ? {
        channelId,
        repo: 'weautomatehq1/IFleet',
        workDir: ROUTE_WORKDIR.current,
        defaultBranch: 'main' as const,
        defaultModel: 'opus' as const,
        allowedUserIds: [USER],
        codeowners: [],
      }
    : null;
}

const router: ChannelRouter = { resolve: route, list: () => [] };

function makeControlPlane(): ControlPlaneClient & { posted: ControlCommand[] } {
  const posted: ControlCommand[] = [];
  return {
    posted,
    postCommand: async (cmd) => {
      posted.push(cmd);
      return { accepted: true, taskId: `T-${posted.length}`, threadId: `TH-${posted.length}` };
    },
  };
}

function makeInteraction(target: string | null): {
  interaction: any;
  editReply: ReturnType<typeof vi.fn>;
} {
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    isChatInputCommand: () => true,
    isButton: () => false,
    commandName: 'audit-fix',
    channelId: CHAN,
    id: 'INTERACTION_1',
    deferred: false,
    replied: false,
    user: { id: USER, username: 'seb' },
    options: { getString: vi.fn((key: string) => (key === 'target' ? target : null)) },
    deferReply: vi.fn(async () => undefined),
    editReply,
  };
  return { interaction, editReply };
}

interface SeedFinding {
  id: string;
  severity?: 'CRITICAL' | 'IMPORTANT' | 'COSMETIC';
  status?: string;
}

function writeIndex(repoRoot: string, findings: SeedFinding[]): void {
  const auditsDir = join(repoRoot, '.audits');
  mkdirSync(auditsDir, { recursive: true });
  const full = findings.map((f) => ({
    id: f.id,
    severity: f.severity ?? 'IMPORTANT',
    category: 'logic',
    title: `title ${f.id}`,
    detail: 'detail',
    file_globs: ['src/**'],
    fix_sketch: 'fix it',
    parallel_safe: true,
    fingerprint: `fp-${f.id}`,
    status: f.status ?? 'open',
    opened_at: '2026-05-22T00:00:00Z',
    closed_at: null,
    closing_pr: null,
  }));
  writeFileSync(
    join(auditsDir, 'index.json'),
    JSON.stringify({
      repo: 'IFleet',
      last_updated: '2026-05-22T00:00:00Z',
      open_findings: full.length,
      by_severity: {},
      findings: full,
    }),
    'utf8',
  );
}

function readStatus(repoRoot: string, id: string): string | undefined {
  const raw = JSON.parse(readFileSync(join(repoRoot, '.audits', 'index.json'), 'utf8'));
  return raw.findings.find((f: { id: string }) => f.id === id)?.status;
}

describe('/audit-fix handler', () => {
  let repoRoot: string;
  let prevRepoRoot: string | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'audit-fix-handler-'));
    prevRepoRoot = process.env['IFLEET_REPO_ROOT'];
    process.env['IFLEET_REPO_ROOT'] = repoRoot;
    ROUTE_WORKDIR.current = repoRoot;
  });

  afterEach(() => {
    if (prevRepoRoot === undefined) delete process.env['IFLEET_REPO_ROOT'];
    else process.env['IFLEET_REPO_ROOT'] = prevRepoRoot;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('list mode replies with grouped findings and posts nothing', async () => {
    writeIndex(repoRoot, [
      { id: 'AUDIT-IFleet-list0001', severity: 'CRITICAL' },
      { id: 'AUDIT-IFleet-list0002', severity: 'IMPORTANT' },
      { id: 'AUDIT-IFleet-list0003', severity: 'COSMETIC' },
    ]);
    const controlPlane = makeControlPlane();
    const { interaction, editReply } = makeInteraction(null);

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(controlPlane.posted).toHaveLength(0);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('Open audit findings'));
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('(3 open)'));
  });

  it('fix-one submits a sprint_goal with the audit-fix prefix and marks the finding fixing', async () => {
    writeIndex(repoRoot, [
      { id: 'AUDIT-IFleet-one00001' },
      { id: 'AUDIT-IFleet-one00002' },
    ]);
    const controlPlane = makeControlPlane();
    const { interaction } = makeInteraction('AUDIT-IFleet-one00001');

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(controlPlane.posted).toHaveLength(1);
    const cmd = controlPlane.posted[0];
    expect(cmd?.type).toBe('sprint_goal');
    if (cmd?.type === 'sprint_goal') {
      expect(cmd.goal.startsWith('[audit-fix:AUDIT-IFleet-one00001]')).toBe(true);
      expect(cmd.repo).toBe('weautomatehq1/IFleet');
    }
    expect(readStatus(repoRoot, 'AUDIT-IFleet-one00001')).toBe('fixing');
    expect(readStatus(repoRoot, 'AUDIT-IFleet-one00002')).toBe('open');
  });

  it('auto mode queues every open finding and marks them all fixing', async () => {
    writeIndex(repoRoot, [
      { id: 'AUDIT-IFleet-auto0001', severity: 'CRITICAL' },
      { id: 'AUDIT-IFleet-auto0002', severity: 'IMPORTANT' },
      { id: 'AUDIT-IFleet-auto0003', severity: 'COSMETIC' },
    ]);
    const controlPlane = makeControlPlane();
    const { interaction, editReply } = makeInteraction('auto');

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(controlPlane.posted).toHaveLength(3);
    expect(new Set(controlPlane.posted.map((c) => c.idempotencyKey)).size).toBe(3);
    expect(readStatus(repoRoot, 'AUDIT-IFleet-auto0001')).toBe('fixing');
    expect(readStatus(repoRoot, 'AUDIT-IFleet-auto0002')).toBe('fixing');
    expect(readStatus(repoRoot, 'AUDIT-IFleet-auto0003')).toBe('fixing');
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('Queued 3 findings'));
  });

  it('replies with a friendly error when no audit index exists', async () => {
    const controlPlane = makeControlPlane();
    const { interaction, editReply } = makeInteraction(null);

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(controlPlane.posted).toHaveLength(0);
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining('No audit findings yet'),
    );
  });

  it('auto mode reports total failure (not "Queued 0") when every dispatch fails', async () => {
    writeIndex(repoRoot, [
      { id: 'AUDIT-IFleet-allf0001' },
      { id: 'AUDIT-IFleet-allf0002' },
    ]);
    const controlPlane: ControlPlaneClient = {
      postCommand: async () => {
        throw new Error('control plane down');
      },
    };
    const { interaction, editReply } = makeInteraction('auto');

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(readStatus(repoRoot, 'AUDIT-IFleet-allf0001')).toBe('open');
    expect(readStatus(repoRoot, 'AUDIT-IFleet-allf0002')).toBe('open');
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('Failed to queue all 2'));
  });

  it('reverts a finding to open when the control plane rejects the dispatch', async () => {
    writeIndex(repoRoot, [{ id: 'AUDIT-IFleet-fail0001' }]);
    const controlPlane: ControlPlaneClient = {
      postCommand: async () => {
        throw new Error('control plane down');
      },
    };
    const { interaction, editReply } = makeInteraction('AUDIT-IFleet-fail0001');

    await handleInteractionCreate(interaction, { router, controlPlane });

    expect(readStatus(repoRoot, 'AUDIT-IFleet-fail0001')).toBe('open');
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('Failed to queue'));
  });
});
