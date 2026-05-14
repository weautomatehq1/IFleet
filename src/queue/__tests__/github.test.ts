import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GitHubQueue, THROTTLE_MAX_RETRIES, shouldRetryRateLimit } from '../github.js';
import type { QueuedTask } from '../types.js';

interface FakeIssue {
  number: number;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string | null }>;
  created_at: string;
  html_url: string;
  node_id: string;
}

interface MockState {
  issues: FakeIssue[];
  comments: Array<{ id: number; issue: number; body: string }>;
  addedLabels: Array<{ issue: number; labels: string[] }>;
  removedLabels: Array<{ issue: number; name: string }>;
  nextCommentId: number;
}

function mockOctokit(state: MockState): unknown {
  const paginate = async (
    _fn: unknown,
    params: { labels?: string; issue_number?: number },
  ): Promise<unknown[]> => {
    if (params.issue_number !== undefined) {
      return state.comments.filter((c) => c.issue === params.issue_number);
    }
    return state.issues.filter((i) => {
      if (!params.labels) return true;
      const wanted = params.labels.split(',');
      const have = i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? ''));
      return wanted.every((w) => have.includes(w));
    });
  };

  return {
    paginate,
    issues: {
      listForRepo: () => undefined,
      listComments: () => undefined,
      addLabels: async (p: { issue_number: number; labels: string[] }) => {
        state.addedLabels.push({ issue: p.issue_number, labels: p.labels });
        const issue = state.issues.find((i) => i.number === p.issue_number);
        if (issue) {
          for (const l of p.labels) {
            if (!issue.labels.some((x) => (typeof x === 'string' ? x : x.name) === l)) {
              issue.labels.push(l);
            }
          }
        }
      },
      removeLabel: async (p: { issue_number: number; name: string }) => {
        state.removedLabels.push({ issue: p.issue_number, name: p.name });
        const issue = state.issues.find((i) => i.number === p.issue_number);
        if (issue) {
          issue.labels = issue.labels.filter((l) => (typeof l === 'string' ? l : l.name) !== p.name);
        }
      },
      createComment: async (p: { issue_number: number; body: string }) => {
        const id = state.nextCommentId++;
        state.comments.push({ id, issue: p.issue_number, body: p.body });
        return { data: { id } };
      },
      updateComment: async (p: { comment_id: number; body: string }) => {
        const c = state.comments.find((x) => x.id === p.comment_id);
        if (c) c.body = p.body;
      },
    },
  };
}

function makeState(issues: FakeIssue[]): MockState {
  return {
    issues,
    comments: [],
    addedLabels: [],
    removedLabels: [],
    nextCommentId: 1000,
  };
}

const REPO = { owner: 'weautomatehq1', name: 'IFleet' };

function makeQueue(state: MockState, now = () => Date.parse('2026-05-12T12:00:00Z')): GitHubQueue {
  return new GitHubQueue(mockOctokit(state) as never, { repos: [REPO], now });
}

describe('GitHubQueue.pickNext', () => {
  it('returns null when no auto:ship issues', async () => {
    const state = makeState([]);
    const q = makeQueue(state);
    const next = await q.pickNext();
    assert.equal(next, null);
  });

  it('skips issues already labeled in_flight', async () => {
    const state = makeState([
      {
        number: 1,
        title: 'busy',
        labels: ['auto:ship', 'in_flight'],
        created_at: '2026-05-10T00:00:00Z',
        html_url: 'u',
        node_id: 'a',
      },
    ]);
    const q = makeQueue(state);
    const next = await q.pickNext();
    assert.equal(next, null);
  });

  it('prefers priority:high then oldest createdAt', async () => {
    const state = makeState([
      {
        number: 1,
        title: 'old normal',
        labels: ['auto:ship'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u1',
        node_id: 'n1',
      },
      {
        number: 2,
        title: 'newer high',
        labels: ['auto:ship', 'priority:high'],
        created_at: '2026-05-05T00:00:00Z',
        html_url: 'u2',
        node_id: 'n2',
      },
      {
        number: 3,
        title: 'oldest high',
        labels: ['auto:ship', 'priority:high'],
        created_at: '2026-04-01T00:00:00Z',
        html_url: 'u3',
        node_id: 'n3',
      },
    ]);
    const q = makeQueue(state);
    const next = await q.pickNext();
    assert.ok(next);
    assert.equal(next!.issueNumber, 3);
  });

  it('respects excludeIds', async () => {
    const state = makeState([
      {
        number: 1,
        title: 'only',
        labels: ['auto:ship'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'skip-me',
      },
    ]);
    const q = makeQueue(state);
    const next = await q.pickNext({ excludeIds: ['skip-me'] });
    assert.equal(next, null);
  });
});

describe('GitHubQueue lifecycle', () => {
  function makeTask(extra: Partial<QueuedTask> = {}): QueuedTask {
    return {
      id: 'nid',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 42,
      title: 't',
      body: '',
      labels: ['auto:ship'],
      routingHints: { priority: 'normal', verify: ['typecheck'], autonomy: 'auto' },
      createdAt: 0,
      url: 'u',
      ...extra,
    };
  }

  it('markPicked adds in_flight label and comments with worker + timestamp', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    await q.markPicked(makeTask(), 'worker-1');
    assert.deepEqual(state.addedLabels[0]?.labels, ['in_flight']);
    const comment = state.comments[0]?.body ?? '';
    assert.match(comment, /Picked up by `worker-1`/);
    assert.match(comment, /2026-05-12T12:00:00\.000Z/);
  });

  it('markCompleted removes in_flight, adds auto:shipped, posts PR link', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship', 'in_flight'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    await q.markCompleted(makeTask(), 'https://github.com/x/y/pull/1');
    assert.deepEqual(state.removedLabels[0], { issue: 42, name: 'in_flight' });
    assert.deepEqual(state.addedLabels[0]?.labels, ['auto:shipped']);
    assert.match(state.comments[0]?.body ?? '', /PR: https:\/\/github.com\/x\/y\/pull\/1/);
  });

  it('markFailed records reason', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship', 'in_flight'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    await q.markFailed(makeTask(), 'CI red');
    assert.deepEqual(state.addedLabels[0]?.labels, ['auto:failed']);
    assert.match(state.comments[0]?.body ?? '', /Failed: CI red/);
  });

  it('markCapabilityBlocked removes in_flight, adds blocked label, posts comment', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship', 'in_flight'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    await q.markCapabilityBlocked(makeTask(), ['docker', 'colima']);
    assert.deepEqual(state.removedLabels[0], { issue: 42, name: 'in_flight' });
    assert.deepEqual(state.addedLabels[0]?.labels, ['blocked:missing-capability']);
    const body = state.comments[0]?.body ?? '';
    assert.match(body, /Cannot run/);
    assert.match(body, /`docker`/);
    assert.match(body, /`colima`/);
  });

  it('postStatus creates a comment then updates the same one on second call', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    await q.postStatus(makeTask(), 'editing');
    await q.postStatus(makeTask(), 'reviewing', 'looking good');
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0]!.body, /Status:.*reviewing/);
    assert.match(state.comments[0]!.body, /looking good/);
  });
});

describe('shouldRetryRateLimit (throttling wiring)', () => {
  it('returns true for the first few retries (primary)', () => {
    const logs: string[] = [];
    const log = (m: string): void => {
      logs.push(m);
    };
    for (let i = 0; i < THROTTLE_MAX_RETRIES; i++) {
      const retry = shouldRetryRateLimit(
        5,
        { method: 'GET', url: '/x', request: { retryCount: i } },
        'primary',
        log,
      );
      assert.equal(retry, true, `attempt ${i + 1} should retry`);
    }
    assert.equal(logs.length, THROTTLE_MAX_RETRIES);
    assert.match(logs[0]!, /rate limit hit/);
  });

  it('returns false once retry budget is exhausted', () => {
    const log = (): void => {};
    const retry = shouldRetryRateLimit(
      5,
      { method: 'GET', url: '/x', request: { retryCount: THROTTLE_MAX_RETRIES } },
      'primary',
      log,
    );
    assert.equal(retry, false);
  });

  it('handles secondary rate limit responses with the same budget', () => {
    const log = (): void => {};
    const ok = shouldRetryRateLimit(
      10,
      { method: 'POST', url: '/issues', request: { retryCount: 0 } },
      'secondary',
      log,
    );
    assert.equal(ok, true);

    const exhausted = shouldRetryRateLimit(
      10,
      { method: 'POST', url: '/issues', request: { retryCount: THROTTLE_MAX_RETRIES + 5 } },
      'secondary',
      log,
    );
    assert.equal(exhausted, false);
  });

  it('logs which kind of rate limit was hit', () => {
    const logs: string[] = [];
    shouldRetryRateLimit(
      2,
      { method: 'GET', url: '/', request: { retryCount: 0 } },
      'secondary',
      (m) => logs.push(m),
    );
    assert.match(logs[0]!, /secondary rate limit/);
  });

  it('does not throw when method/url are missing', () => {
    const ok = shouldRetryRateLimit(1, { request: { retryCount: 0 } }, 'primary', () => {});
    assert.equal(ok, true);
  });
});
