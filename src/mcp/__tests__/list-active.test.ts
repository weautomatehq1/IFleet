import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { listActive } from '../tools/list-active.js';
import type { IssueRef } from '../octokit.js';
import { createMockOctokit } from './fixtures/mock-octokit.js';

const DEFAULT_REPO = 'weautomatehq1/IFleet';

function issue(number: number, labels: string[], state: 'open' | 'closed' = 'open'): IssueRef {
  return {
    number,
    url: `https://github.com/weautomatehq1/IFleet/issues/${number}`,
    state,
    labels,
    title: `issue ${number}`,
    body: '',
  };
}

describe('listActive', () => {
  it('returns the union of in_flight and auto:ship open issues, deduplicated', async () => {
    const { client } = createMockOctokit([
      issue(1, ['auto:ship']),
      issue(2, ['in_flight']),
      issue(3, ['auto:ship', 'in_flight']),
      issue(4, ['auto:shipped'], 'closed'),
    ]);

    const result = await listActive(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      {},
    );

    assert.equal(result.count, 3);
    const ids = result.sprints.map((s) => s.issueNumber).sort();
    assert.deepEqual(ids, [1, 2, 3]);
    const ship3 = result.sprints.find((s) => s.issueNumber === 3);
    assert.equal(ship3?.status, 'in_flight');
    const ship1 = result.sprints.find((s) => s.issueNumber === 1);
    assert.equal(ship1?.status, 'pending');
  });

  it('returns an empty list when no labels match', async () => {
    const { client } = createMockOctokit();
    const result = await listActive(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      {},
    );
    assert.equal(result.count, 0);
    assert.deepEqual(result.sprints, []);
    assert.equal(result.repo, DEFAULT_REPO);
  });
});
