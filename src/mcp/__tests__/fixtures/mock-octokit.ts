import type { IssueRef, McpOctokit } from '../../octokit.js';

export interface MockCall {
  tool: 'createIssue' | 'getIssue' | 'addLabels' | 'listIssuesByLabels';
  args: unknown;
}

export interface MockState {
  issues: Map<number, IssueRef>;
  nextNumber: number;
  calls: MockCall[];
}

export interface MockOctokit {
  client: McpOctokit;
  state: MockState;
}

export function createMockOctokit(initial: IssueRef[] = []): MockOctokit {
  const state: MockState = {
    issues: new Map(),
    nextNumber: 1,
    calls: [],
  };
  for (const issue of initial) {
    state.issues.set(issue.number, issue);
    if (issue.number >= state.nextNumber) state.nextNumber = issue.number + 1;
  }

  const client: McpOctokit = {
    async createIssue({ owner, repo, title, body, labels }) {
      state.calls.push({ tool: 'createIssue', args: { owner, repo, title, body, labels } });
      const number = state.nextNumber++;
      const url = `https://github.com/${owner}/${repo}/issues/${number}`;
      const issue: IssueRef = { number, url, state: 'open', labels: [...labels], title, body };
      state.issues.set(number, issue);
      return { number, url };
    },
    async getIssue({ issueNumber }) {
      state.calls.push({ tool: 'getIssue', args: { issueNumber } });
      const found = state.issues.get(issueNumber);
      if (!found) throw new Error(`mock: issue #${issueNumber} not found`);
      return found;
    },
    async addLabels({ issueNumber, labels }) {
      state.calls.push({ tool: 'addLabels', args: { issueNumber, labels } });
      const found = state.issues.get(issueNumber);
      if (!found) throw new Error(`mock: issue #${issueNumber} not found`);
      const merged = new Set([...found.labels, ...labels]);
      state.issues.set(issueNumber, { ...found, labels: [...merged] });
    },
    async listIssuesByLabels({ labels, state: stateFilter }) {
      state.calls.push({ tool: 'listIssuesByLabels', args: { labels, state: stateFilter } });
      const out: IssueRef[] = [];
      for (const issue of state.issues.values()) {
        if (stateFilter !== 'all' && issue.state !== stateFilter) continue;
        if (labels.every((l) => issue.labels.includes(l))) out.push(issue);
      }
      return out;
    },
  };

  return { client, state };
}
