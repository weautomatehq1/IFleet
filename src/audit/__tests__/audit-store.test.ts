import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditFinding } from '../types.js';

// ---------------------------------------------------------------------------
// pg-client mock — must be declared before importing audit-store
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn();
const mockPool = {
  query: mockQuery,
  connect: mockConnect,
};

vi.mock('../../agents/indexer/pg-client.js', () => ({
  getKgPool: () => mockPool,
}));

// Import under test after mock is declared
const {
  dbUpsertFindings,
  dbReadFindings,
  dbReadIndex,
  dbUpdateFindingStatus,
  normaliseAuditRepo,
} = await import('../audit-store.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: 'AUDIT-IFleet-test001',
    severity: 'IMPORTANT',
    category: 'testing',
    title: 'Test finding',
    detail: 'Test detail',
    file_globs: ['src/**/*.ts'],
    fix_sketch: 'Fix it',
    parallel_safe: true,
    fingerprint: 'fp-abc123',
    status: 'open',
    opened_at: '2024-01-01T00:00:00.000Z',
    closed_at: null,
    closing_pr: null,
    ...overrides,
  };
}

/** Simulate a row as pg returns it (dates as Date objects). */
function makeDbRow(overrides: Partial<AuditFinding> = {}): Record<string, unknown> {
  const f = makeFinding(overrides);
  return {
    ...f,
    opened_at: new Date(f.opened_at),
    closed_at: f.closed_at ? new Date(f.closed_at) : null,
  };
}

// ---------------------------------------------------------------------------
// normaliseAuditRepo
// ---------------------------------------------------------------------------

describe('normaliseAuditRepo', () => {
  it('returns basename when org-qualified slug provided', () => {
    expect(normaliseAuditRepo('weautomatehq1/IFleet')).toBe('IFleet');
  });

  it('returns unchanged when no slash', () => {
    expect(normaliseAuditRepo('IFleet')).toBe('IFleet');
  });
});

// ---------------------------------------------------------------------------
// dbUpsertFindings
// ---------------------------------------------------------------------------

describe('dbUpsertFindings', () => {
  let clientMock: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clientMock = { query: vi.fn().mockResolvedValue({ rows: [] }), release: mockRelease };
    mockConnect.mockResolvedValue(clientMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when findings array is empty', async () => {
    await dbUpsertFindings([], 'IFleet');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('wraps inserts in a transaction (BEGIN + COMMIT)', async () => {
    const finding = makeFinding();
    await dbUpsertFindings([finding], 'IFleet');

    const calls: string[] = clientMock.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('executes INSERT with correct parameter order', async () => {
    const finding = makeFinding({ opened_at: '2024-06-01T10:00:00.000Z' });
    await dbUpsertFindings([finding], 'IFleet');

    // Find the actual INSERT call (not BEGIN/COMMIT)
    const insertCall = clientMock.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];

    expect(params[0]).toBe(finding.id);             // $1 id
    expect(params[1]).toBe('IFleet');               // $2 repo (normalised)
    expect(params[2]).toBe(finding.severity);       // $3 severity
    expect(params[3]).toBe(finding.category);       // $4 category
    expect(params[9]).toBe(finding.fingerprint);    // $10 fingerprint
    expect(params[10]).toBe(finding.status);        // $11 status
    expect(params[11]).toBe(finding.opened_at);     // $12 opened_at
  });

  it('normalises org-qualified repo before INSERT', async () => {
    const finding = makeFinding();
    await dbUpsertFindings([finding], 'weautomatehq1/IFleet');

    const insertCall = clientMock.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT'),
    );
    const params = insertCall![1] as unknown[];
    expect(params[1]).toBe('IFleet'); // normalised
  });

  it('uses current timestamp when opened_at is blank', async () => {
    const before = Date.now();
    const finding = makeFinding({ opened_at: '' });
    await dbUpsertFindings([finding], 'IFleet');
    const after = Date.now();

    const insertCall = clientMock.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT'),
    );
    const params = insertCall![1] as unknown[];
    const usedDate = new Date(params[11] as string).getTime();
    expect(usedDate).toBeGreaterThanOrEqual(before);
    expect(usedDate).toBeLessThanOrEqual(after + 100);
  });

  it('ROLLBACKs and rethrows on query error', async () => {
    clientMock.query.mockImplementationOnce(() => Promise.resolve()) // BEGIN succeeds
      .mockImplementationOnce(() => Promise.reject(new Error('db error'))); // INSERT fails

    await expect(dbUpsertFindings([makeFinding()], 'IFleet')).rejects.toThrow('db error');
    const calls: string[] = clientMock.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls).toContain('ROLLBACK');
    expect(clientMock.release).toHaveBeenCalled();
  });

  it('INSERT SQL uses WHERE NOT EXISTS to avoid re-inserting active-status findings', async () => {
    const finding = makeFinding();
    await dbUpsertFindings([finding], 'IFleet');

    const insertCall = clientMock.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT'),
    );
    expect(insertCall![0]).toContain("WHERE NOT EXISTS");
    expect(insertCall![0]).toMatch(/status NOT IN/);
  });
});

// ---------------------------------------------------------------------------
// dbReadFindings
// ---------------------------------------------------------------------------

describe('dbReadFindings', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped findings for a repo', async () => {
    const row = makeDbRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const results = await dbReadFindings('IFleet');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('AUDIT-IFleet-test001');
    expect(typeof results[0]!.opened_at).toBe('string'); // ISO string, not Date
  });

  it('passes normalised repo key to SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dbReadFindings('weautomatehq1/IFleet');

    const params = (mockQuery.mock.calls[0] as unknown[][])[1] as unknown[];
    expect(params[0]).toBe('IFleet');
  });

  it('converts Date objects to ISO strings', async () => {
    const closedDate = new Date('2024-03-15T12:00:00.000Z');
    const row = makeDbRow({ closed_at: '2024-03-15T12:00:00.000Z' });
    (row as Record<string, unknown>).closed_at = closedDate;
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const results = await dbReadFindings('IFleet');
    expect(results[0]!.closed_at).toBe(closedDate.toISOString());
  });

  it('returns empty array when no rows found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const results = await dbReadFindings('IFleet');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dbReadIndex
// ---------------------------------------------------------------------------

describe('dbReadIndex', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when DB throws', async () => {
    // dbReadIndex calls dbReadFindings which calls pool.query
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    const result = await dbReadIndex('IFleet');
    expect(result).toBeNull();
  });

  it('returns null when no findings exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await dbReadIndex('IFleet');
    expect(result).toBeNull();
  });

  it('returns AuditIndex with correct shape', async () => {
    const rows = [makeDbRow({ status: 'open' })];
    mockQuery.mockResolvedValueOnce({ rows });

    const index = await dbReadIndex('IFleet');
    expect(index).not.toBeNull();
    expect(index!.repo).toBe('IFleet');
    expect(index!.open_findings).toBe(1);
    expect(index!.by_severity).toHaveProperty('IMPORTANT');
    expect(index!.by_severity.IMPORTANT).toBe(1);
    expect(index!.findings).toHaveLength(1);
  });

  it('open_findings excludes closed-status findings', async () => {
    const rows = [
      makeDbRow({ id: 'f1', status: 'open' }),
      makeDbRow({ id: 'f2', status: 'closed' }),
      makeDbRow({ id: 'f3', status: 'fixing' }),
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const index = await dbReadIndex('IFleet');
    expect(index!.open_findings).toBe(1); // only 'open' counts (isActiveAuditStatus); 'fixing' and 'closed' excluded
  });

  it('open_findings excludes fixed and stale statuses', async () => {
    // isActiveAuditStatus counts only 'open' and 'reopened'.
    // 'verifying', 'fixing', 'closed', 'fixed', 'stale' are all excluded.
    const rows = [
      makeDbRow({ id: 'f1', status: 'open' }),
      makeDbRow({ id: 'f2', status: 'verifying' }),
      makeDbRow({ id: 'f3', status: 'reopened' }),
      makeDbRow({ id: 'f4', status: 'closed' }),
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const index = await dbReadIndex('IFleet');
    expect(index!.open_findings).toBe(2); // 'open' + 'reopened' only
  });

  it('by_severity counts only active findings', async () => {
    const rows = [
      makeDbRow({ id: 'f1', severity: 'CRITICAL', status: 'open' }),
      makeDbRow({ id: 'f2', severity: 'CRITICAL', status: 'closed' }),
      makeDbRow({ id: 'f3', severity: 'COSMETIC', status: 'open' }),
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const index = await dbReadIndex('IFleet');
    expect(index!.by_severity.CRITICAL).toBe(1); // not 2
    expect(index!.by_severity.COSMETIC).toBe(1);
    expect(index!.by_severity.IMPORTANT).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dbUpdateFindingStatus
// ---------------------------------------------------------------------------

describe('dbUpdateFindingStatus', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes UPDATE with correct params — status only', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await dbUpdateFindingStatus('AUDIT-IFleet-test001', 'closed');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE audit_findings');
    expect(sql).toContain('SET status = $2');
    expect(params[0]).toBe('AUDIT-IFleet-test001');
    expect(params[1]).toBe('closed');
    expect(params[2]).toBeNull();   // closed_at not provided
    expect(params[3]).toBeNull();   // closing_pr not provided
  });

  it('passes closed_at and closing_pr when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await dbUpdateFindingStatus('AUDIT-IFleet-test001', 'closed', {
      closed_at: '2024-06-01T00:00:00.000Z',
      closing_pr: 'https://github.com/org/repo/pull/42',
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe('2024-06-01T00:00:00.000Z');
    expect(params[3]).toBe('https://github.com/org/repo/pull/42');
  });

  it('does not throw when finding does not exist (no-op)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(
      dbUpdateFindingStatus('AUDIT-IFleet-nonexistent', 'open'),
    ).resolves.toBeUndefined();
  });
});
