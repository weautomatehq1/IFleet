import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GitHubQueue, THROTTLE_MAX_RETRIES, isAuthorAllowed, shouldRetryRateLimit } from '../github.js';
import type { QueuedTask } from '../types.js';
import {
  COOLDOWN_MS,
  LABEL_AUTO_SHIP,
  LABEL_FAILED,
  LABEL_IFLEET_COOLDOWN,
  LABEL_RETRY_PREFIX,
} from '../types.js';

interface FakeIssue {
  number: number;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string | null }>;
  created_at: string;
  html_url: string;
  node_id: string;
  user?: { login?: string | null } | null;
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

/**
 * Extended mock with events support for sweepCooldowns tests.
 * `findLabelAddedAt` uses `octokit.paginate(octokit.issues.listEvents, ...)`.
 * The base mock routes all `issue_number` paginate calls to comments — this
 * version routes `listEvents` calls to the events table instead.
 */
interface FakeEvent {
  issue: number;
  event: string;
  label?: { name: string };
  created_at: string;
}

interface MockStateWithEvents extends MockState {
  events: FakeEvent[];
}

function makeStateWithEvents(issues: FakeIssue[]): MockStateWithEvents {
  return { ...makeState(issues), events: [] };
}

function mockOctokitWithEvents(state: MockStateWithEvents): unknown {
  const listEvents = () => undefined; // sentinel used to route paginate

  const paginate = async (
    fn: unknown,
    params: { labels?: string; issue_number?: number },
  ): Promise<unknown[]> => {
    if (fn === listEvents && params.issue_number !== undefined) {
      return state.events.filter((e) => e.issue === params.issue_number);
    }
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
      listEvents,
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

  it('skips issues already labeled auto:failed (terminal state, no auto-retry)', async () => {
    const state = makeState([
      {
        number: 75,
        title: 'previously attempted',
        labels: ['auto:ship', 'auto:failed', 'priority:high'],
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
      author: '',
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
    // markPicked removes `auto:ship` so a crash mid-pipeline can't re-queue
    // the same issue on the next cron tick (the bug that burned tokens on
    // #70/#72/#75). `ifleet:in_progress` is the new state marker.
    assert.deepEqual(state.removedLabels[0], { issue: 42, name: 'auto:ship' });
    assert.deepEqual(state.addedLabels[0]?.labels, ['in_flight', 'ifleet:in_progress']);
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
    assert.deepEqual(state.removedLabels[1], { issue: 42, name: 'ifleet:in_progress' });
    assert.deepEqual(state.addedLabels[0]?.labels, ['auto:shipped', 'ifleet:done']);
    assert.match(state.comments[0]?.body ?? '', /PR: https:\/\/github.com\/x\/y\/pull\/1/);
  });

  it('markFailed records reason and bumps retry counter to 1', async () => {
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
    assert.deepEqual(state.addedLabels[0]?.labels, ['auto:failed', 'ifleet:cooldown', 'ifleet:retry:1']);
    assert.match(state.comments[0]?.body ?? '', /Failed: CI red/);
    assert.match(state.comments[0]?.body ?? '', /retry 1\/2/);
  });

  it('markFailed at the retry cap marks ifleet:chronic-fail and disables auto-retry', async () => {
    const state = makeState([
      {
        number: 42,
        title: 't',
        labels: ['auto:ship', 'in_flight', 'ifleet:retry:1'],
        created_at: '2026-05-01T00:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    const q = makeQueue(state);
    const task = makeTask({ labels: ['auto:ship', 'in_flight', 'ifleet:retry:1'] });
    await q.markFailed(task, 'second CI red');
    // Bumps retry:1 → retry:2, adds chronic-fail since 2 >= MAX_AUTO_RETRIES.
    assert.deepEqual(
      state.addedLabels[0]?.labels,
      ['auto:failed', 'ifleet:cooldown', 'ifleet:retry:2', 'ifleet:chronic-fail'],
    );
    const removed = state.removedLabels.map((r) => r.name);
    assert.ok(removed.includes('ifleet:retry:1'), 'prior retry label removed');
    assert.match(state.comments[0]?.body ?? '', /chronic-fail/);
    assert.match(state.comments[0]?.body ?? '', /auto-retry disabled/);
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

describe('isAuthorAllowed', () => {
  it('accepts authors in the allowlist', () => {
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r', allowedAuthors: ['alice', 'bob'] }, 'alice'), true);
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r', allowedAuthors: ['alice', 'bob'] }, 'bob'), true);
  });

  it('rejects authors not in the allowlist', () => {
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r', allowedAuthors: ['alice'] }, 'mallory'), false);
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r', allowedAuthors: ['alice'] }, ''), false);
  });

  it('permits everyone in legacy mode (allowlist undefined)', () => {
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r' }, 'anyone'), true);
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r' }, ''), true);
  });

  it('permits everyone when allowlist is an empty array (legacy mode)', () => {
    assert.equal(isAuthorAllowed({ owner: 'o', name: 'r', allowedAuthors: [] }, 'anyone'), true);
  });
});

describe('GitHubQueue.pickNext author allowlist', () => {
  const REPO_GUARDED = { owner: 'weautomatehq1', name: 'IFleet', allowedAuthors: ['alice'] } as const;

  function makeGuardedQueue(state: MockState): GitHubQueue {
    return new GitHubQueue(mockOctokit(state) as never, {
      repos: [REPO_GUARDED],
      now: () => Date.parse('2026-05-15T12:00:00Z'),
    });
  }

  it('returns an issue when author is in the allowlist', async () => {
    const state = makeState([
      {
        number: 7,
        title: 'ok',
        labels: ['auto:ship'],
        created_at: '2026-05-15T10:00:00Z',
        html_url: 'u',
        node_id: 'n-ok',
        user: { login: 'alice' },
      },
    ]);
    const q = makeGuardedQueue(state);
    const next = await q.pickNext();
    assert.ok(next);
    assert.equal(next!.issueNumber, 7);
    assert.equal(next!.author, 'alice');
  });

  it('skips issues whose author is not in the allowlist', async () => {
    const state = makeState([
      {
        number: 9,
        title: 'evil',
        labels: ['auto:ship'],
        created_at: '2026-05-15T10:00:00Z',
        html_url: 'u',
        node_id: 'n-evil',
        user: { login: 'mallory' },
      },
    ]);
    const q = makeGuardedQueue(state);
    const next = await q.pickNext();
    assert.equal(next, null);
  });

  it('skips disallowed author and picks the next allowed one', async () => {
    const state = makeState([
      {
        number: 9,
        title: 'evil first',
        labels: ['auto:ship', 'priority:high'],
        created_at: '2026-05-15T09:00:00Z',
        html_url: 'u',
        node_id: 'n-evil',
        user: { login: 'mallory' },
      },
      {
        number: 7,
        title: 'ok',
        labels: ['auto:ship'],
        created_at: '2026-05-15T10:00:00Z',
        html_url: 'u',
        node_id: 'n-ok',
        user: { login: 'alice' },
      },
    ]);
    const q = makeGuardedQueue(state);
    const next = await q.pickNext();
    assert.ok(next);
    assert.equal(next!.issueNumber, 7);
  });

  it('treats missing user.login as empty string and rejects when allowlist is set', async () => {
    const state = makeState([
      {
        number: 11,
        title: 'no user',
        labels: ['auto:ship'],
        created_at: '2026-05-15T10:00:00Z',
        html_url: 'u',
        node_id: 'n-nouser',
        user: null,
      },
    ]);
    const q = makeGuardedQueue(state);
    const next = await q.pickNext();
    assert.equal(next, null);
  });
});

// ---------------------------------------------------------------------------
// sweepCooldowns — full retry-cap cycle (AUDIT-IFleet-73be8513)
// ---------------------------------------------------------------------------

describe('GitHubQueue.sweepCooldowns — retry label preserved across restore', () => {
  const COOLDOWN_JUST_ELAPSED = COOLDOWN_MS + 1000;

  function makeTask(extra: Partial<QueuedTask> = {}): QueuedTask {
    return {
      id: 'nid',
      repo: 'weautomatehq1/IFleet',
      issueNumber: 42,
      title: 't',
      body: '',
      author: '',
      labels: ['auto:ship', 'in_flight'],
      routingHints: { priority: 'normal', verify: [], autonomy: 'auto' },
      createdAt: 0,
      url: 'u',
      ...extra,
    };
  }

  /**
   * Build a queue with the clock set so `cooldownLabeledAt + COOLDOWN_MS` is
   * in the past — forcing sweepCooldowns to restore the issue immediately.
   */
  function makeSweeperQueue(state: MockStateWithEvents): GitHubQueue {
    const cooldownLabeledAt = Date.parse('2026-05-12T10:00:00Z');
    const now = () => cooldownLabeledAt + COOLDOWN_JUST_ELAPSED;
    return new GitHubQueue(mockOctokitWithEvents(state) as never, { repos: [REPO], now });
  }

  it('sweepCooldowns restores a cooled-down issue (removes cooldown, adds auto:ship)', async () => {
    const state = makeStateWithEvents([
      {
        number: 42,
        title: 't',
        labels: [LABEL_IFLEET_COOLDOWN, LABEL_FAILED, `${LABEL_RETRY_PREFIX}1`],
        created_at: '2026-05-12T09:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    // Provide the labeled event so findLabelAddedAt succeeds
    state.events.push({
      issue: 42,
      event: 'labeled',
      label: { name: LABEL_IFLEET_COOLDOWN },
      created_at: '2026-05-12T10:00:00Z',
    });

    const q = makeSweeperQueue(state);
    const { restored } = await q.sweepCooldowns();
    assert.equal(restored, 1);

    const labels = (state.issues[0]?.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    assert.ok(labels.includes(LABEL_AUTO_SHIP), 'auto:ship added');
    assert.ok(!labels.includes(LABEL_IFLEET_COOLDOWN), 'ifleet:cooldown removed');
    assert.ok(!labels.includes(LABEL_FAILED), 'auto:failed removed');
  });

  it('full cycle: markFailed → sweepCooldowns → markFailed again reads retry from labels', async () => {
    // Phase 1: first failure — issue has no prior retry label
    const state = makeStateWithEvents([
      {
        number: 42,
        title: 't',
        labels: [LABEL_AUTO_SHIP, 'in_flight'],
        created_at: '2026-05-12T09:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);

    // Use a fixed base clock; sweep will use base + COOLDOWN_JUST_ELAPSED
    const cooldownLabeledAt = Date.parse('2026-05-12T10:00:00Z');
    const nowRef = { value: cooldownLabeledAt };
    const q = new GitHubQueue(mockOctokitWithEvents(state) as never, {
      repos: [REPO],
      now: () => nowRef.value,
    });

    // markFailed from in_flight — task carries no prior retry label
    const task1 = makeTask({ labels: [LABEL_AUTO_SHIP, 'in_flight'] });
    await q.markFailed(task1, 'CI red round 1');

    // Verify retry:1 was added
    let labels = (state.issues[0]?.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    assert.ok(labels.includes(`${LABEL_RETRY_PREFIX}1`), 'retry:1 set after first failure');
    assert.ok(labels.includes(LABEL_IFLEET_COOLDOWN), 'cooldown set');

    // Phase 2: advance time past cooldown and sweep
    nowRef.value = cooldownLabeledAt + COOLDOWN_JUST_ELAPSED;
    state.events.push({
      issue: 42,
      event: 'labeled',
      label: { name: LABEL_IFLEET_COOLDOWN },
      // The event timestamp is when the label was added — at cooldownLabeledAt
      created_at: new Date(cooldownLabeledAt).toISOString(),
    });

    const { restored } = await q.sweepCooldowns();
    assert.equal(restored, 1, 'sweep restored the issue');

    labels = (state.issues[0]?.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    assert.ok(labels.includes(LABEL_AUTO_SHIP), 'auto:ship restored');
    assert.ok(!labels.includes(LABEL_IFLEET_COOLDOWN), 'cooldown removed');
    // sweepCooldowns removes retry labels as a tidiness step (b06f33f2)
    assert.ok(!labels.includes(`${LABEL_RETRY_PREFIX}1`), 'retry:1 removed by sweep');

    // Phase 3: second failure. Task no longer has a retry label (sweep cleared
    // it), so markFailed reads from issue labels live — retry should be 1 again
    // (fresh start after sweep cleared the label).
    const task2 = makeTask({ labels: [LABEL_AUTO_SHIP, 'in_flight'] });
    await q.markFailed(task2, 'CI red round 2');

    labels = (state.issues[0]?.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    // After sweep cleared retry:1, the second failure should add retry:1 again
    assert.ok(labels.includes(`${LABEL_RETRY_PREFIX}1`), 'retry:1 added again after sweep + re-fail');
    assert.ok(!labels.includes(`${LABEL_RETRY_PREFIX}2`), 'retry:2 NOT added (counter reset by sweep)');
  });

  it('sweepCooldowns skips issues with ifleet:chronic-fail', async () => {
    const state = makeStateWithEvents([
      {
        number: 42,
        title: 't',
        labels: [LABEL_IFLEET_COOLDOWN, LABEL_FAILED, 'ifleet:chronic-fail', `${LABEL_RETRY_PREFIX}2`],
        created_at: '2026-05-12T09:00:00Z',
        html_url: 'u',
        node_id: 'nid',
      },
    ]);
    state.events.push({
      issue: 42,
      event: 'labeled',
      label: { name: LABEL_IFLEET_COOLDOWN },
      created_at: '2026-05-12T10:00:00Z',
    });

    const q = makeSweeperQueue(state);
    const { restored, skippedChronic } = await q.sweepCooldowns();
    assert.equal(restored, 0);
    assert.equal(skippedChronic, 1);

    const labels = (state.issues[0]?.labels ?? []).map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    // Issue NOT restored — still has cooldown
    assert.ok(labels.includes(LABEL_IFLEET_COOLDOWN), 'cooldown not removed for chronic-fail');
    assert.ok(!labels.includes(LABEL_AUTO_SHIP), 'auto:ship not re-added for chronic-fail');
  });
});
