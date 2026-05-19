export interface ParsedSprintId {
  owner: string;
  repo: string;
  repoSlug: string;
  issueNumber: number;
}

const ID_REGEX = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

export function parseSprintId(raw: string): ParsedSprintId {
  const trimmed = raw.trim();
  const m = ID_REGEX.exec(trimmed);
  if (!m) {
    throw new Error(`mcp: invalid sprint id "${raw}" (expected "owner/name#number")`);
  }
  const owner = m[1]!;
  const repo = m[2]!;
  const issueNumber = Number(m[3]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`mcp: invalid issue number in sprint id "${raw}"`);
  }
  return { owner, repo, repoSlug: `${owner}/${repo}`, issueNumber };
}

export function buildSprintId(repoSlug: string, issueNumber: number): string {
  return `${repoSlug}#${issueNumber}`;
}
