import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { submitSprint } from '../tools/submit-sprint.js';
import { createMockOctokit, type MockCall } from './fixtures/mock-octokit.js';

const DEFAULT_REPO = 'weautomatehq1/IFleet';

describe('submitSprint', () => {
  it('creates an auto:ship issue in the default repo and returns the sprint id', async () => {
    const { client, state } = createMockOctokit();
    const result = await submitSprint(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      { brief: 'add MCP server' },
    );

    assert.equal(result.repo, DEFAULT_REPO);
    assert.equal(result.issueNumber, 1);
    assert.equal(result.id, `${DEFAULT_REPO}#1`);
    assert.match(result.url, /^https:\/\/github\.com\/weautomatehq1\/IFleet\/issues\/1$/);

    const call = state.calls.find((c: MockCall) => c.tool === 'createIssue');
    assert.ok(call);
    const args = call.args as { owner: string; repo: string; labels: string[]; body: string };
    assert.equal(args.owner, 'weautomatehq1');
    assert.equal(args.repo, 'IFleet');
    assert.deepEqual(args.labels, ['auto:ship']);
    assert.match(args.body, /<!-- source: mcp -->/);
  });

  it('honours an explicit repo override and emits a mode:<value> label', async () => {
    const { client, state } = createMockOctokit();
    await submitSprint(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      { brief: 'tune classifier', repo: 'weautomatehq1/factory', mode: 'ralph' },
    );

    const call = state.calls.find((c) => c.tool === 'createIssue')!;
    const args = call.args as { owner: string; repo: string; body: string; labels: string[] };
    assert.equal(args.owner, 'weautomatehq1');
    assert.equal(args.repo, 'factory');
    assert.deepEqual(args.labels, ['auto:ship', 'mode:ralph']);
    assert.doesNotMatch(args.body, /<!-- mode:/);
  });

  it('omits the mode label when no mode is supplied', async () => {
    const { client, state } = createMockOctokit();
    await submitSprint(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      { brief: 'plain brief' },
    );
    const call = state.calls.find((c) => c.tool === 'createIssue')!;
    const args = call.args as { labels: string[] };
    assert.deepEqual(args.labels, ['auto:ship']);
  });

  it('rejects mode values outside the classifier SprintMode union', async () => {
    const { client } = createMockOctokit();
    await assert.rejects(
      submitSprint(
        { octokit: client, defaultRepo: DEFAULT_REPO },
        // @ts-expect-error — exercising the runtime zod guard
        { brief: 'x', mode: 'overnight' },
      ),
    );
  });

  it('derives a title from the first non-empty brief line when no title is supplied', async () => {
    const { client, state } = createMockOctokit();
    await submitSprint(
      { octokit: client, defaultRepo: DEFAULT_REPO },
      { brief: '\n# First line\nrest of brief' },
    );
    const call = state.calls.find((c) => c.tool === 'createIssue')!;
    const args = call.args as { title: string };
    assert.equal(args.title, 'First line');
  });

  it('rejects malformed repo overrides', async () => {
    const { client } = createMockOctokit();
    await assert.rejects(
      submitSprint({ octokit: client, defaultRepo: DEFAULT_REPO }, { brief: 'x', repo: 'bad-repo' }),
    );
  });
});
