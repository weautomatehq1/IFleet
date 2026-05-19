// Minimal Octokit surface the MCP tools depend on. Lets tests pass plain
// objects without pulling the full @octokit/rest type into every test file.

export interface IssueRef {
  number: number;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  title: string;
  body: string;
}

export interface McpOctokit {
  createIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }>;

  getIssue(args: {
    owner: string;
    repo: string;
    issueNumber: number;
  }): Promise<IssueRef>;

  addLabels(args: {
    owner: string;
    repo: string;
    issueNumber: number;
    labels: string[];
  }): Promise<void>;

  listIssuesByLabels(args: {
    owner: string;
    repo: string;
    labels: string[];
    state: 'open' | 'closed' | 'all';
  }): Promise<IssueRef[]>;
}

interface IssueRestData {
  number: number;
  html_url: string;
  state: string;
  labels: Array<string | { name?: string | null | undefined }>;
  title: string;
  body?: string | null;
}

function rowToIssue(data: IssueRestData): IssueRef {
  return {
    number: data.number,
    url: data.html_url,
    state: data.state === 'closed' ? 'closed' : 'open',
    labels: data.labels
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter((s): s is string => s.length > 0),
    title: data.title,
    body: data.body ?? '',
  };
}

export interface RestClient {
  issues: {
    create(opts: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      labels: string[];
    }): Promise<{ data: IssueRestData }>;
    get(opts: {
      owner: string;
      repo: string;
      issue_number: number;
    }): Promise<{ data: IssueRestData }>;
    addLabels(opts: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<{ data: unknown }>;
    listForRepo(opts: {
      owner: string;
      repo: string;
      labels: string;
      state: 'open' | 'closed' | 'all';
      per_page: number;
    }): Promise<{ data: IssueRestData[] }>;
  };
}

/** Adapts a real Octokit-shaped client to the MCP-internal interface. */
export function makeOctokitAdapter(rest: RestClient): McpOctokit {
  return {
    async createIssue({ owner, repo, title, body, labels }) {
      const res = await rest.issues.create({ owner, repo, title, body, labels });
      return { number: res.data.number, url: res.data.html_url };
    },
    async getIssue({ owner, repo, issueNumber }) {
      const res = await rest.issues.get({ owner, repo, issue_number: issueNumber });
      return rowToIssue(res.data);
    },
    async addLabels({ owner, repo, issueNumber, labels }) {
      await rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    },
    async listIssuesByLabels({ owner, repo, labels, state }) {
      const res = await rest.issues.listForRepo({
        owner,
        repo,
        labels: labels.join(','),
        state,
        per_page: 100,
      });
      return res.data.map(rowToIssue);
    },
  };
}
