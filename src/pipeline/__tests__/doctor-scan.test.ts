import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '../../observability/types.js';
import {
  buildScanPrompt,
  hasNotableEvents,
  runRollupCycle,
  runScanCycle,
  SCAN_DISABLED_ENV,
  shouldRunDailyRollup,
  type ClaudeRunner,
  type DiscordPoster,
  type EventReader,
} from '../doctor-scan.js';

function fakeEvents(kinds: string[]): Event[] {
  return kinds.map((kind, i) => ({
    ts: 1_700_000_000_000 + i,
    sprintId: 's',
    kind,
    payload: {},
  }));
}

function captureDiscord(): DiscordPoster & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async post(content: string): Promise<void> {
      posts.push(content);
    },
  };
}

function fakeClaude(reply: string): ClaudeRunner {
  return {
    async run(): Promise<string> {
      return reply;
    },
  };
}

const STORED_DISABLED = process.env[SCAN_DISABLED_ENV];
beforeEach(() => {
  delete process.env[SCAN_DISABLED_ENV];
});
afterEach(() => {
  if (STORED_DISABLED === undefined) delete process.env[SCAN_DISABLED_ENV];
  else process.env[SCAN_DISABLED_ENV] = STORED_DISABLED;
});

describe('hasNotableEvents', () => {
  it('returns true on failures, errors, or rate limit pressure', () => {
    expect(hasNotableEvents(fakeEvents(['task.failed']))).toBe(true);
    expect(hasNotableEvents(fakeEvents(['worker.rateLimit']))).toBe(true);
    expect(hasNotableEvents(fakeEvents(['error']))).toBe(true);
  });

  it('returns false on a happy run', () => {
    expect(hasNotableEvents(fakeEvents(['task.picked', 'task.start', 'task.done']))).toBe(false);
  });
});

describe('buildScanPrompt', () => {
  it('includes a clear OK contract and renders each event', () => {
    const out = buildScanPrompt(fakeEvents(['task.failed', 'error']));
    expect(out).toContain('OK');
    expect(out).toContain('task.failed');
    expect(out).toContain('error');
  });
});

describe('shouldRunDailyRollup', () => {
  it('does not fire before the rollup hour', () => {
    const now = new Date(2026, 4, 18, 5, 30); // 05:30 local
    expect(shouldRunDailyRollup(now, undefined, 6)).toBe(false);
  });

  it('fires once after the rollup hour with no prior run', () => {
    const now = new Date(2026, 4, 18, 6, 5);
    expect(shouldRunDailyRollup(now, undefined, 6)).toBe(true);
  });

  it('does not fire twice in the same local day', () => {
    const now = new Date(2026, 4, 18, 9, 0);
    const earlier = new Date(2026, 4, 18, 6, 5).toISOString();
    expect(shouldRunDailyRollup(now, earlier, 6)).toBe(false);
  });

  it('fires again the next local day', () => {
    const now = new Date(2026, 4, 19, 6, 5);
    const yesterday = new Date(2026, 4, 18, 6, 5).toISOString();
    expect(shouldRunDailyRollup(now, yesterday, 6)).toBe(true);
  });
});

describe('runScanCycle', () => {
  function reader(events: Event[]): EventReader {
    return { readRecent: () => events };
  }

  it('no-ops on a happy event window', async () => {
    const discord = captureDiscord();
    const out = await runScanCycle({
      events: reader(fakeEvents(['task.picked', 'task.done'])),
      claude: fakeClaude('something'),
      discord,
    });
    expect(out.posted).toBe(false);
    expect(discord.posts).toEqual([]);
  });

  it('posts a one-liner when Haiku returns a non-empty summary', async () => {
    const discord = captureDiscord();
    const out = await runScanCycle({
      events: reader(fakeEvents(['task.failed', 'error'])),
      claude: fakeClaude('flaky test on T-76 — 3 failures in 20 min'),
      discord,
    });
    expect(out.posted).toBe(true);
    expect(discord.posts).toHaveLength(1);
    expect(discord.posts[0]).toContain('Doctor scan');
    expect(discord.posts[0]).toContain('T-76');
  });

  it('honors DOCTOR_SCAN_DISABLED=1 kill switch', async () => {
    process.env[SCAN_DISABLED_ENV] = '1';
    const discord = captureDiscord();
    const out = await runScanCycle({
      events: reader(fakeEvents(['task.failed'])),
      claude: fakeClaude('would say something'),
      discord,
    });
    expect(out.posted).toBe(false);
    expect(discord.posts).toEqual([]);
  });
});

describe('runRollupCycle', () => {
  function repoWithLearnings(name: string, lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), `rollup-cycle-${name}-`));
    mkdirSync(join(dir, '.omc'), { recursive: true });
    writeFileSync(join(dir, '.omc', 'learnings.md'), lines.join('\n'), 'utf8');
    return dir;
  }

  it('posts the haiku summary when one is returned', async () => {
    const repo = repoWithLearnings('happy', [
      '- 2099-01-01 09:00 | T-1 | first thing',
      '- 2099-01-01 10:00 | T-2 | second thing',
    ]);
    const discord = captureDiscord();
    const out = await runRollupCycle({
      repoRoots: [repo],
      claude: fakeClaude('IFleet shipped two fixes and stayed under budget.'),
      discord,
      sinceTs: '2099-01-01 00:00',
    });
    expect(out.posted).toBe(true);
    expect(discord.posts[0]).toContain('Morning brief');
    expect(discord.posts[0]).toContain('shipped two fixes');
  });

  it('falls back to deterministic digest when Haiku is empty', async () => {
    const repo = repoWithLearnings('fallback', [
      '- 2099-01-01 09:00 | T-1 | catch flaky tests',
    ]);
    const discord = captureDiscord();
    const out = await runRollupCycle({
      repoRoots: [repo],
      claude: fakeClaude(''),
      discord,
      sinceTs: '2099-01-01 00:00',
    });
    expect(out.posted).toBe(true);
    expect(discord.posts[0]).toContain('catch flaky tests');
  });

  it('still posts a "nothing overnight" message when no learnings exist', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'rollup-empty-'));
    const discord = captureDiscord();
    const out = await runRollupCycle({
      repoRoots: [empty],
      claude: fakeClaude('ignored'),
      discord,
      sinceTs: '2099-01-01 00:00',
    });
    expect(out.posted).toBe(true);
    expect(discord.posts[0]).toMatch(/no new learnings/);
  });

  it('dedupes identical learnings across repos before sending', async () => {
    const r1 = repoWithLearnings('dup-1', ['- 2099-01-01 09:00 | T-1 | flaky test on auth']);
    const r2 = repoWithLearnings('dup-2', ['- 2099-01-01 09:30 | T-2 | flaky test on auth']);
    const discord = captureDiscord();
    let captured = '';
    await runRollupCycle({
      repoRoots: [r1, r2],
      claude: { async run(prompt) { captured = prompt; return ''; } },
      discord,
      sinceTs: '2099-01-01 00:00',
    });
    // Haiku prompt only sees one copy.
    const occurrences = (captured.match(/flaky test on auth/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
