// Long-running PM2 entry for the doctor self-heal cadence. Drives two cycles:
//
//   - Periodic Haiku scan (every DOCTOR_SCAN_INTERVAL_MS, default 30 min):
//     reads the last 50 events from the most recent sprint's event log, asks
//     Haiku "any patterns of failure I should escalate?", posts a one-line
//     summary to Discord #ifleet when notable events are present.
//
//   - Morning rollup (once per local day after DOCTOR_ROLLUP_HOUR_LOCAL,
//     default 06:00): reads `.omc/learnings.md` across every repo in
//     `config/repos.json`, dedupes, asks Haiku for a summary, posts.
//
// PM2 is configured with `autorestart: false` and the env var
// `DOCTOR_SCAN_DISABLED=1`, so this script no-ops until T5 manually flips
// both off via `pm2 set doctor-scan:DOCTOR_SCAN_DISABLED 0 && pm2 restart doctor-scan`.
//
// Manual trigger (development):
//   DOCTOR_SCAN_DISABLED=0 DOCTOR_SCAN_INTERVAL_MS=10000 \
//     DISCORD_IFLEET_WEBHOOK=... node --import tsx scripts/doctor-scan.ts

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { loadReposConfig } from '../src/config/repos.js';
import {
  DEFAULT_SCAN_INTERVAL_MS,
  runRollupCycle,
  runScanCycle,
  shouldRunDailyRollup,
  SCAN_DISABLED_ENV,
  type ClaudeRunner,
  type DiscordPoster,
  type EventReader,
} from '../src/pipeline/doctor-scan.js';
import { FileEventLog } from '@wahq/orchestrator-core/observability/event-log';
import type { Event } from '@wahq/orchestrator-core/observability/types';
import { claudeChildEnv } from '@wahq/orchestrator-core/workers/claude-env';

const STATE_PATH = resolve(process.cwd(), '.omc', 'doctor-scan.state.json');

interface State {
  lastRollupISO?: string;
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const claudeRunner: ClaudeRunner = {
  run(prompt: string, model: string): Promise<string> {
    return new Promise((resolveOut) => {
      const claudePath = process.env['CLAUDE_PATH'] ?? 'claude';
      let out = '';
      const proc = spawn(
        claudePath,
        ['-p', prompt, '--model', model, '--permission-mode', 'default', '--allowedTools', ''],
        { env: claudeChildEnv() },
      );
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolveOut(out.trim()));
      proc.on('error', () => resolveOut(''));
    });
  },
};

const discord: DiscordPoster = {
  async post(content: string): Promise<void> {
    const url = process.env['DISCORD_IFLEET_WEBHOOK'];
    if (!url) return;
    return new Promise((resolveOut) => {
      try {
        const body = JSON.stringify({ content });
        const u = new URL(url);
        const req = request(
          {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => { res.resume(); res.on('end', resolveOut); },
        );
        req.on('error', () => resolveOut());
        req.write(body);
        req.end();
      } catch {
        resolveOut();
      }
    });
  },
};

function latestSprintEventReader(): EventReader {
  return {
    readRecent(limit: number): Event[] {
      const log = new FileEventLog();
      const sprintsDir = resolve(process.cwd(), '.omc', 'sprints');
      if (!existsSync(sprintsDir)) return [];
      let latestDir: { id: string; mtime: number } | undefined;
      try {
        for (const name of readdirSafe(sprintsDir)) {
          const eventsFile = join(sprintsDir, name, 'events.jsonl');
          if (!existsSync(eventsFile)) continue;
          const stat = safeStat(eventsFile);
          if (!stat) continue;
          if (!latestDir || stat.mtimeMs > latestDir.mtime) {
            latestDir = { id: name, mtime: stat.mtimeMs };
          }
        }
      } catch {
        return [];
      }
      if (!latestDir) return [];
      const events = log.read(latestDir.id);
      return events.slice(-limit);
    },
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(file: string): { mtimeMs: number } | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function repoRoots(): string[] {
  try {
    const cfg = loadReposConfig(resolve(process.cwd(), 'config', 'repos.json'));
    const baseDir = process.env['DOCTOR_SCAN_REPOS_DIR']
      ?? resolve(process.env['HOME'] ?? '', 'dev', 'ai-products');
    return Object.values(cfg).map((r) => resolve(baseDir, r.name));
  } catch {
    return [];
  }
}

async function tick(state: State): Promise<State> {
  try {
    await runScanCycle({
      events: latestSprintEventReader(),
      claude: claudeRunner,
      discord,
    });
  } catch (err) {
    console.warn(`[doctor-scan] scan cycle error: ${(err as Error).message}`);
  }

  if (shouldRunDailyRollup(new Date(), state.lastRollupISO)) {
    try {
      const result = await runRollupCycle({
        repoRoots: repoRoots(),
        claude: claudeRunner,
        discord,
      });
      if (result.posted) state.lastRollupISO = new Date().toISOString();
    } catch (err) {
      console.warn(`[doctor-scan] rollup cycle error: ${(err as Error).message}`);
    }
  }
  return state;
}

async function main(): Promise<void> {
  const intervalMs = Number(process.env['DOCTOR_SCAN_INTERVAL_MS']) || DEFAULT_SCAN_INTERVAL_MS;
  console.warn(
    `[doctor-scan] starting (interval=${intervalMs}ms, disabled=${process.env[SCAN_DISABLED_ENV] ?? '0'})`,
  );

  let state = loadState();
  const loop = async (): Promise<void> => {
    state = await tick(state);
    saveState(state);
  };

  await loop();
  setInterval(() => { void loop(); }, intervalMs);
}

// Only run when invoked as the entry point (skip during test imports).
const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.endsWith('doctor-scan.ts') || argv1.endsWith('doctor-scan.js');
  } catch {
    return false;
  }
})();
if (isMain) {
  void main();
}
