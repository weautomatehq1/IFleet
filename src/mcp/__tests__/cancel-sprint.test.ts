import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cancelSprint } from '../tools/cancel-sprint.js';
import type { IssueRef } from '../octokit.js';
import { createMockOctokit } from './fixtures/mock-octokit.js';

function fixture(): IssueRef {
  return {
    number: 7,
    url: 'https://github.com/weautomatehq1/IFleet/issues/7',
    state: 'open',
    labels: ['auto:ship', 'in_flight'],
    title: 't',
    body: 'b',
  };
}

describe('cancelSprint', () => {
  it('adds blocked:missing-capability and preserves existing labels', async () => {
    const { client, state } = createMockOctokit([fixture()]);
    const result = await cancelSprint(
      { octokit: client },
      { id: 'weautomatehq1/IFleet#7', reason: 'operator stop' },
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.reason, 'operator stop');
    assert.equal(result.id, 'weautomatehq1/IFleet#7');

    const addCall = state.calls.find((c) => c.tool === 'addLabels');
    assert.ok(addCall);
    const args = addCall.args as { issueNumber: number; labels: string[] };
    assert.equal(args.issueNumber, 7);
    assert.deepEqual(args.labels, ['blocked:missing-capability']);

    const updated = state.issues.get(7);
    assert.ok(updated);
    assert.ok(updated.labels.includes('blocked:missing-capability'));
    assert.ok(updated.labels.includes('auto:ship'));
  });

  it('defaults the reason when not supplied', async () => {
    const { client } = createMockOctokit([fixture()]);
    const result = await cancelSprint({ octokit: client }, { id: 'weautomatehq1/IFleet#7' });
    assert.equal(result.reason, 'cancelled via mcp');
  });
});
