import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveRepoPath } from '../audit-ritual.ts';

describe('audit-ritual — resolveRepoPath', () => {
  const originalIfleetRoot = process.env['IFLEET_REPO_ROOT'];
  const originalAuditBase = process.env['AUDIT_BASE_DIR'];

  beforeEach(() => {
    delete process.env['IFLEET_REPO_ROOT'];
    delete process.env['AUDIT_BASE_DIR'];
  });

  afterEach(() => {
    if (originalIfleetRoot !== undefined) {
      process.env['IFLEET_REPO_ROOT'] = originalIfleetRoot;
    } else {
      delete process.env['IFLEET_REPO_ROOT'];
    }
    if (originalAuditBase !== undefined) {
      process.env['AUDIT_BASE_DIR'] = originalAuditBase;
    } else {
      delete process.env['AUDIT_BASE_DIR'];
    }
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
