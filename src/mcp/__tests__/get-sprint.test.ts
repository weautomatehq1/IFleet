import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getSprint } from '../tools/get-sprint.js';
import type { IssueRef } from '../octokit.js';
import { createMockOctokit } from './fixtures/mock-octokit.js';

function fixture(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    number: 42,
    url: 'https://github.com/weautomatehq1/IFleet/issues/42',
    state: 'open',
    labels: ['auto:ship'],
    title: 'do thing',
    body: '<!-- source: mcp -->\n\nthe brief',
    ...overrides,
  };
}

describe('getSprint', () => {
  it('classifies a pending open issue as "pending" and strips the source header', async () => {
    const { client } = createMockOctokit([fixture()]);
    const result = await getSprint({ octokit: client }, { id: 'weautomatehq1/IFleet#42' });
    assert.equal(result.status, 'pending');
    assert.equal(result.brief, 'the brief');
    assert.equal(result.issueNumber, 42);
    assert.equal(result.repo, 'weautomatehq1/IFleet');
  });

  it('returns "in_flight" when the in_flight label is present', async () => {
    const { client } = createMockOctokit([
      fixture({ labels: ['auto:ship', 'in_flight'] }),
    ]);
    const result = await getSprint({ octokit: client }, { id: 'weautomatehq1/IFleet#42' });
    assert.equal(result.status, 'in_flight');
  });

  it('returns "blocked" when the capability-blocked label is set', async () => {
    const { client } = createMockOctokit([
      fixture({ labels: ['auto:ship', 'blocked:missing-capability'] }),
    ]);
    const result = await getSprint({ octokit: client }, { id: 'weautomatehq1/IFleet#42' });
    assert.equal(result.status, 'blocked');
  });

  it('returns "shipped" when the issue is closed with auto:shipped', async () => {
    const { client } = createMockOctokit([
      fixture({ state: 'closed', labels: ['auto:shipped'] }),
    ]);
    const result = await getSprint({ octokit: client }, { id: 'weautomatehq1/IFleet#42' });
    assert.equal(result.status, 'shipped');
  });

  it('rejects malformed ids', async () => {
    const { client } = createMockOctokit();
    await assert.rejects(getSprint({ octokit: client }, { id: 'no-slash-or-hash' }));
  });
});
