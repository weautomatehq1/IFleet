#!/usr/bin/env node

export function classifyPR(title: string, body: string): string {
  const text = `${title} ${body}`.toLowerCase();

  // Feature patterns
  if (/\b(add|new|create|implement|feature)\b/.test(text)) return 'feature';

  // Bugfix patterns
  if (/\b(fix|bug|issue|broken|error|crash)\b/.test(text)) return 'bugfix';

  // Refactor patterns
  if (/\b(refactor|cleanup|improve|optimize|simplify|rewrite)\b/.test(text)) return 'refactor';

  // Docs patterns
  if (/\b(docs?|documentation|readme|guide|comment|doc)\b/.test(text)) return 'docs';

  // Default to feature
  return 'feature';
}
