const MAX_SLUG_LEN = 40;

const CONVENTIONAL_TYPES = new Set([
  'feat', 'fix', 'chore', 'docs', 'refactor',
  'test', 'ci', 'build', 'perf', 'style',
]);

interface PrefixResult {
  type: string;
  rest: string;
}

function extractConventionalPrefix(title: string): PrefixResult {
  // Matches "type(optional-scope): rest" or "type: rest"
  const match = /^([a-z]+)(?:\([^)]*\))?:\s*(.*)$/i.exec(title);
  if (match !== null) {
    const rawType = match[1];
    const rawRest = match[2];
    if (rawType !== undefined && rawRest !== undefined) {
      const candidate = rawType.toLowerCase();
      if (CONVENTIONAL_TYPES.has(candidate)) {
        return { type: candidate, rest: rawRest };
      }
    }
  }
  return { type: 'chore', rest: title };
}

function slugify(text: string, maxLen: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug || 'task';
}

export function titleToBranchName(issueNumber: number, title: string): string {
  const { type, rest } = extractConventionalPrefix(title);
  const slug = slugify(rest, MAX_SLUG_LEN);
  return `${type}/smoke-${issueNumber}-${slug}`;
}
