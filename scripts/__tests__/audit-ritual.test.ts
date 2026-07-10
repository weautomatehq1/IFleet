import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { AuditFinding, AuditIndex } from '../../src/audit/types.js';

// ---------------------------------------------------------------------------
// Hoist mocks — must run before module imports AND vi.mock factories.
//
// audit-ritual.ts does: const execFileAsync = promisify(execFile) at module
// load. A plain vi.fn() lacks util.promisify.custom, so promisify falls back
// to the standard single-value callback form which returns a Buffer, not
// { stdout, stderr }. Setting the custom symbol on execFileMock makes
// promisify(execFileMock) === execFileCustomMock, giving us an async mock
// whose resolved value is { stdout, stderr } as the real execFile does.
// ---------------------------------------------------------------------------

const { execFileMock, execFileCustomMock, execSyncMock } = vi.hoisted(() => {
  const execFileCustomMock = vi.fn<
    (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>
  >();
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileCustomMock,
    configurable: true,
    writable: true,
  });
  const execSyncMock = vi.fn(() => '/usr/local/bin/claude');
  return { execFileMock, execFileCustomMock, execSyncMock };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, execSync: execSyncMock };
});

vi.mock('@wahq/orchestrator-core/discord/audit-runner', () => ({
  resolveAuditIndexPath: vi.fn((repoPath: string) => `${repoPath}/.audits/index.json`),
  readAuditIndex: vi.fn(),
  markFindingsClosed: vi.fn(() => 0),
  openFindings: vi.fn((idx: AuditIndex) =>
    idx.findings.filter((f) => f.status === 'open' || f.status === 'reopened'),
  ),
}));

import { resolveRepoPath, AUDIT_ID_RE, reconcileMergedPRs } from '../audit-ritual.ts';
import { readAuditIndex, markFindingsClosed } from '@wahq/orchestrator-core/discord/audit-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: 'AUDIT-IFleet-aabbccdd',
    severity: 'IMPORTANT',
    category: 'logic',
    title: 'test finding',
    detail: '',
    file_globs: ['scripts/audit-ritual.ts'],
    fix_sketch: '',
    parallel_safe: true,
    fingerprint: 'fp',
    status: 'open',
    opened_at: new Date().toISOString(),
    closed_at: null,
    closing_pr: null,
    ...overrides,
  };
}

function makeIndex(overrides: Partial<AuditIndex> = {}): AuditIndex {
  return {
    repo: 'IFleet',
    last_updated: new Date().toISOString(),
    open_findings: 1,
    by_severity: { CRITICAL: 0, IMPORTANT: 1, COSMETIC: 0 },
    findings: [makeFinding()],
    ...overrides,
  };
}

function mockGhSuccess(stdout: string): void {
  execFileCustomMock.mockResolvedValue({ stdout, stderr: '' });
}

// ---------------------------------------------------------------------------
// resolveRepoPath
// ---------------------------------------------------------------------------

describe('audit-ritual — resolveRepoPath', () => {
  const origIfleetRoot = process.env['IFLEET_REPO_ROOT'];
  const origAuditBase = process.env['AUDIT_BASE_DIR'];

  beforeEach(() => {
    delete process.env['IFLEET_REPO_ROOT'];
    delete process.env['AUDIT_BASE_DIR'];
  });

  afterEach(() => {
    if (origIfleetRoot !== undefined) process.env['IFLEET_REPO_ROOT'] = origIfleetRoot;
    else delete process.env['IFLEET_REPO_ROOT'];
    if (origAuditBase !== undefined) process.env['AUDIT_BASE_DIR'] = origAuditBase;
    else delete process.env['AUDIT_BASE_DIR'];
  });

  it('returns IFLEET_REPO_ROOT when repo is "IFleet" and env var is set', () => {
    process.env['IFLEET_REPO_ROOT'] = '/var/ifleet-test';
    expect(resolveRepoPath('IFleet')).toBe('/var/ifleet-test');
  });

  it('falls back to process.cwd() for IFleet when IFLEET_REPO_ROOT is unset', () => {
    expect(resolveRepoPath('IFleet')).toBe(process.cwd());
  });

  it('resolves a sibling-repo to <ifleet>/../<repo> by default', () => {
    process.env['IFLEET_REPO_ROOT'] = '/var/ifleet-test';
    expect(resolveRepoPath('factory')).toBe(resolve('/var/ifleet-test', '..', 'factory'));
  });

  it('honors AUDIT_BASE_DIR override for non-IFleet repos', () => {
    process.env['IFLEET_REPO_ROOT'] = '/var/ifleet-test';
    process.env['AUDIT_BASE_DIR'] = '/srv/repos';
    expect(resolveRepoPath('factory')).toBe(resolve('/srv/repos', 'factory'));
  });
});

// ---------------------------------------------------------------------------
// AUDIT_ID_RE
// ---------------------------------------------------------------------------

describe('audit-ritual — AUDIT_ID_RE', () => {
  function match(text: string): string[] | null {
    return text.match(new RegExp(AUDIT_ID_RE.source, AUDIT_ID_RE.flags));
  }

  it('matches a canonical finding ID', () => {
    expect(match('AUDIT-IFleet-c8172704')).toEqual(['AUDIT-IFleet-c8172704']);
  });

  it('matches multiple IDs in a PR body', () => {
    const hits = match('Closes AUDIT-IFleet-c8172704 and AUDIT-factory-deadbeef');
    expect(hits).toHaveLength(2);
    expect(hits).toContain('AUDIT-IFleet-c8172704');
    expect(hits).toContain('AUDIT-factory-deadbeef');
  });

  it('does NOT match an ID with non-hex suffix', () => {
    expect(match('AUDIT-IFleet-zzzzzzzz')).toBeNull();
  });

  it('does NOT match a partial stub like AUDIT-IFleet-T1', () => {
    expect(match('AUDIT-IFleet-T1')).toBeNull();
  });

  it('does NOT match when the suffix is fewer than 8 hex chars', () => {
    expect(match('AUDIT-IFleet-abc123')).toBeNull();
  });

  it('does NOT match when the 8-hex suffix is followed by more word chars', () => {
    expect(match('AUDIT-IFleet-c8172704foo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcileMergedPRs
// ---------------------------------------------------------------------------

describe('audit-ritual — reconcileMergedPRs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    execSyncMock.mockReturnValue('/usr/local/bin/claude');
    process.env['IFLEET_REPO_ROOT'] = '/tmp/ifleet-test';
    delete process.env['IFLEET_KG_DATABASE_URL'];
  });

  afterEach(() => {
    delete process.env['IFLEET_REPO_ROOT'];
    delete process.env['IFLEET_KG_DATABASE_URL'];
  });

  it('queries gh pr list once per repo with distinct --repo flags', async () => {
    mockGhSuccess('[]');
    vi.mocked(readAuditIndex).mockReturnValue(makeIndex());

    await reconcileMergedPRs(['IFleet', 'factory']);

    const calls = execFileCustomMock.mock.calls;
    const repoArgs = calls.map((c) => {
      const args = c[1] as string[];
      const idx = args.indexOf('--repo');
      return idx >= 0 ? args[idx + 1] : null;
    });

    expect(calls).toHaveLength(2);
    // Both repos must be distinct org-prefixed names, not hardcoded to one repo
    expect(new Set(repoArgs).size).toBe(2);
    expect(repoArgs.some((r) => r?.includes('IFleet'))).toBe(true);
    expect(repoArgs.some((r) => r?.includes('factory'))).toBe(true);
  });

  it('includes a 30-day date filter in the gh search flag', async () => {
    mockGhSuccess('[]');
    vi.mocked(readAuditIndex).mockReturnValue(makeIndex());

    await reconcileMergedPRs(['IFleet']);

    const args = execFileCustomMock.mock.calls[0]![1] as string[];
    const searchIdx = args.indexOf('--search');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(args[searchIdx + 1]).toContain('merged:>=');
  });

  it('batches reconciled closures via markFindingsClosed with status:"fixed"', async () => {
    const finding = makeFinding({ id: 'AUDIT-IFleet-aabbccdd', status: 'open' });
    const index = makeIndex({ findings: [finding] });
    vi.mocked(readAuditIndex).mockReturnValue(index);
    vi.mocked(markFindingsClosed).mockReturnValue(1);

    const mergedAt = '2026-05-26T10:00:00.000Z';
    mockGhSuccess(
      JSON.stringify([
        {
          number: 99,
          title: 'fix: closes AUDIT-IFleet-aabbccdd',
          body: '',
          mergedAt,
          url: 'https://github.com/weautomatehq1/IFleet/pull/99',
        },
      ]),
    );

    await reconcileMergedPRs(['IFleet']);

    expect(vi.mocked(markFindingsClosed)).toHaveBeenCalledOnce();
    const [idxArg, closuresArg] = vi.mocked(markFindingsClosed).mock.calls[0]!;
    expect(idxArg).toContain('.audits/index.json');
    expect(closuresArg).toEqual([
      {
        findingId: 'AUDIT-IFleet-aabbccdd',
        prUrl: 'https://github.com/weautomatehq1/IFleet/pull/99',
        closedAt: mergedAt,
        status: 'fixed',
      },
    ]);
  });

  it('does not call markFindingsClosed when no PR references a finding ID', async () => {
    vi.mocked(readAuditIndex).mockReturnValue(
      makeIndex({ findings: [makeFinding({ id: 'AUDIT-IFleet-aabbccdd' })] }),
    );
    mockGhSuccess(
      JSON.stringify([
        {
          number: 1,
          title: 'unrelated PR',
          body: '',
          mergedAt: new Date().toISOString(),
          url: 'https://github.com/weautomatehq1/IFleet/pull/1',
        },
      ]),
    );

    await reconcileMergedPRs(['IFleet']);

    expect(vi.mocked(markFindingsClosed)).not.toHaveBeenCalled();
  });

  it('skips findings already in a terminal state (fixed/closed/stale)', async () => {
    const findings = [
      makeFinding({ id: 'AUDIT-IFleet-aabbccdd', status: 'fixed' }),
      makeFinding({ id: 'AUDIT-IFleet-bbccddee', status: 'closed' }),
      makeFinding({ id: 'AUDIT-IFleet-ccddeeff', status: 'open' }),
    ];
    vi.mocked(readAuditIndex).mockReturnValue(makeIndex({ findings }));
    vi.mocked(markFindingsClosed).mockReturnValue(1);

    mockGhSuccess(
      JSON.stringify([
        {
          number: 42,
          title: 'closes AUDIT-IFleet-aabbccdd and AUDIT-IFleet-bbccddee and AUDIT-IFleet-ccddeeff',
          body: '',
          mergedAt: '2026-05-26T10:00:00.000Z',
          url: 'https://github.com/weautomatehq1/IFleet/pull/42',
        },
      ]),
    );

    await reconcileMergedPRs(['IFleet']);

    expect(vi.mocked(markFindingsClosed)).toHaveBeenCalledOnce();
    const closures = vi.mocked(markFindingsClosed).mock.calls[0]![1];
    // Only the 'open' finding should be batched.
    expect(closures).toHaveLength(1);
    expect(closures[0]?.findingId).toBe('AUDIT-IFleet-ccddeeff');
  });

  it('skips a failed repo and continues with remaining repos', async () => {
    execFileCustomMock
      .mockRejectedValueOnce(new Error('gh: not found'))
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' });
    vi.mocked(readAuditIndex).mockReturnValue(makeIndex());

    await expect(reconcileMergedPRs(['IFleet', 'factory'])).resolves.toBeUndefined();
    expect(execFileCustomMock.mock.calls).toHaveLength(2);
  });
});
