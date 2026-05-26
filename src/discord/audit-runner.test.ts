import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuditFinding,
  type AuditIndex,
  extractAuditFindingId,
  formatFindingsList,
  markFindingClosed,
  markFindingsFixing,
  openFindings,
  readAuditIndex,
  setFindingsStatus,
  synthesizeAuditBrief,
  writeAuditIndex,
} from './audit-runner.js';

function finding(over: Partial<AuditFinding> & { id: string }): AuditFinding {
  return {
    id: over.id,
    severity: over.severity ?? 'IMPORTANT',
    category: over.category ?? 'logic',
    title: over.title ?? `title for ${over.id}`,
    detail: over.detail ?? 'a detailed description',
    file_globs: over.file_globs ?? ['src/**'],
    fix_sketch: over.fix_sketch ?? 'do the fix',
    parallel_safe: over.parallel_safe ?? true,
    fingerprint: over.fingerprint ?? `fp-${over.id}`,
    status: over.status ?? 'open',
    opened_at: over.opened_at ?? '2026-05-22T00:00:00Z',
    closed_at: over.closed_at ?? null,
    closing_pr: over.closing_pr ?? null,
  };
}

function makeIndex(findings: AuditFinding[]): AuditIndex {
  return {
    repo: 'IFleet',
    last_updated: '2026-05-22T00:00:00Z',
    open_findings: findings.length,
    by_severity: { CRITICAL: 0, IMPORTANT: 0, COSMETIC: 0 },
    findings,
  };
}

describe('formatFindingsList', () => {
  it('groups three findings by severity with counts and footer', () => {
    const index = makeIndex([
      finding({ id: 'AUDIT-IFleet-crit0001', severity: 'CRITICAL', title: 'arch allows git' }),
      finding({ id: 'AUDIT-IFleet-crit0002', severity: 'CRITICAL', title: 'no error boundary' }),
      finding({ id: 'AUDIT-IFleet-imp00003', severity: 'IMPORTANT', title: 'git add -A sweeps' }),
    ]);
    const out = formatFindingsList(index);
    expect(out).toContain('**Open audit findings** — IFleet (3 open)');
    expect(out).toContain('**CRITICAL (2)**');
    expect(out).toContain('**IMPORTANT (1)**');
    expect(out).toContain('`AUDIT-IFleet-crit0001` — arch allows git');
    expect(out).toContain('`AUDIT-IFleet-imp00003` — git add -A sweeps');
    expect(out).toContain('/audit-fix auto');
  });

  it('reports zero open findings cleanly', () => {
    const index = makeIndex([
      finding({ id: 'AUDIT-IFleet-done0001', status: 'closed' }),
    ]);
    expect(formatFindingsList(index)).toContain('(0 open)');
  });
});

describe('synthesizeAuditBrief', () => {
  it('prefixes the goal with the [audit-fix:<id>] tag', () => {
    const brief = synthesizeAuditBrief(
      finding({ id: 'AUDIT-IFleet-abc12345', title: 'fix the thing', fix_sketch: 'patch X' }),
    );
    expect(brief.startsWith('[audit-fix:AUDIT-IFleet-abc12345] Fix: fix the thing')).toBe(true);
    expect(brief).toContain('Fix approach: patch X');
    expect(brief).toContain('Files likely affected: src/**');
    expect(brief).toContain('"AUDIT-IFleet-abc12345"');
  });
});

describe('extractAuditFindingId', () => {
  it('recovers the finding id from a synthesized brief', () => {
    const brief = synthesizeAuditBrief(finding({ id: 'AUDIT-IFleet-xyz98765' }));
    expect(extractAuditFindingId(brief)).toBe('AUDIT-IFleet-xyz98765');
  });

  it('returns null for an ordinary goal', () => {
    expect(extractAuditFindingId('add a login page')).toBeNull();
  });
});

describe('openFindings', () => {
  it('returns only open findings, worst severity first', () => {
    const index = makeIndex([
      finding({ id: 'a', severity: 'COSMETIC' }),
      finding({ id: 'b', severity: 'CRITICAL' }),
      finding({ id: 'c', severity: 'IMPORTANT', status: 'fixing' }),
      finding({ id: 'd', severity: 'IMPORTANT' }),
    ]);
    expect(openFindings(index).map((f) => f.id)).toEqual(['b', 'd', 'a']);
  });
});

describe('index read/write + status mutation', () => {
  let dir: string;
  let indexPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-runner-'));
    indexPath = join(dir, 'index.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readAuditIndex returns null when the file is missing', () => {
    expect(readAuditIndex(indexPath)).toBeNull();
  });

  it('round-trips an index through write and read', () => {
    writeAuditIndex(indexPath, makeIndex([finding({ id: 'AUDIT-IFleet-rt000001' })]));
    const back = readAuditIndex(indexPath);
    expect(back?.findings).toHaveLength(1);
    expect(back?.findings[0]?.id).toBe('AUDIT-IFleet-rt000001');
  });

  it('markFindingsFixing flips status to fixing and persists', () => {
    writeAuditIndex(
      indexPath,
      makeIndex([
        finding({ id: 'AUDIT-IFleet-fix00001' }),
        finding({ id: 'AUDIT-IFleet-fix00002' }),
      ]),
    );
    const updated = markFindingsFixing(indexPath, ['AUDIT-IFleet-fix00001']);
    expect(updated).toBe(1);
    const back = readAuditIndex(indexPath);
    expect(back?.findings.find((f) => f.id === 'AUDIT-IFleet-fix00001')?.status).toBe('fixing');
    expect(back?.findings.find((f) => f.id === 'AUDIT-IFleet-fix00002')?.status).toBe('open');
  });

  it('setFindingsStatus can revert a fixing finding back to open', () => {
    writeAuditIndex(indexPath, makeIndex([finding({ id: 'AUDIT-IFleet-rev00001' })]));
    markFindingsFixing(indexPath, ['AUDIT-IFleet-rev00001']);
    setFindingsStatus(indexPath, ['AUDIT-IFleet-rev00001'], 'open');
    expect(readAuditIndex(indexPath)?.findings[0]?.status).toBe('open');
  });

  it('markFindingClosed sets status, closing_pr, closed_at and drops the open count', () => {
    writeAuditIndex(
      indexPath,
      makeIndex([
        finding({ id: 'AUDIT-IFleet-cls00001', severity: 'CRITICAL' }),
        finding({ id: 'AUDIT-IFleet-cls00002', severity: 'IMPORTANT' }),
      ]),
    );
    const ok = markFindingClosed(indexPath, 'AUDIT-IFleet-cls00001', 'https://github.com/x/y/pull/9');
    expect(ok).toBe(true);
    const back = readAuditIndex(indexPath);
    const closed = back?.findings.find((f) => f.id === 'AUDIT-IFleet-cls00001');
    expect(closed?.status).toBe('closed');
    expect(closed?.closing_pr).toBe('https://github.com/x/y/pull/9');
    expect(closed?.closed_at).toBeTruthy();
    expect(back?.open_findings).toBe(1);
    expect(back?.by_severity['CRITICAL']).toBe(0);
  });

  it('markFindingClosed returns false (no throw) when the index is missing', () => {
    expect(markFindingClosed(indexPath, 'AUDIT-IFleet-none0001', 'pr')).toBe(false);
  });

  it('markFindingClosed returns false when the finding id is unknown', () => {
    writeAuditIndex(indexPath, makeIndex([finding({ id: 'AUDIT-IFleet-known001' })]));
    expect(markFindingClosed(indexPath, 'AUDIT-IFleet-ghost001', 'pr')).toBe(false);
  });

  it('readAuditIndex returns null for malformed JSON', () => {
    writeFileSync(indexPath, '{ not json', 'utf8');
    expect(readAuditIndex(indexPath)).toBeNull();
  });

  it('coerces a partial finding written straight to disk', () => {
    writeFileSync(
      indexPath,
      JSON.stringify({ repo: 'IFleet', findings: [{ id: 'AUDIT-IFleet-partial1' }] }),
      'utf8',
    );
    const back = readAuditIndex(indexPath);
    expect(back?.findings[0]?.status).toBe('open');
    expect(back?.findings[0]?.severity).toBe('IMPORTANT');
    expect(readFileSync(indexPath, 'utf8')).toContain('AUDIT-IFleet-partial1');
  });
});
