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
  // Matches "type(optional-scope): rest" or "type: rest".
  // Use explicit [a-zA-Z]+ instead of /i so intent is clear; toLowerCase() normalises afterwards.
  const match = /^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/.exec(title);
  if (match !== null) {
    const rawType = match[1];
    const rawRest = match[2];
    if (rawType !== undefined && rawRest !== undefined) {
      const candidate = rawType.toLowerCase();
      if (CONVENTIONAL_TYPES.has(candidate)) {
        return { type: candidate, rest: rawRest };
      }
      // Type has conventional syntax but is not whitelisted — still use the
      // colon-suffix as rest (not the full title) and default folder to 'chore'.
      return { type: 'chore', rest: rawRest };
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

export function titleToBranchName(taskRef: number | string, title: string): string {
  const { type, rest } = extractConventionalPrefix(title);
  const slug = slugify(rest, MAX_SLUG_LEN);
  const ref = typeof taskRef === 'number' ? String(taskRef) : taskRef.slice(0, 8).toLowerCase();
  return `${type}/smoke-${ref}-${slug}`;
}
