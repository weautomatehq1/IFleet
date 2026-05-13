#!/usr/bin/env node
import { FileEventLog } from './event-log.js';
import type { Event } from './types.js';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

interface CliArgs {
  sprintId?: string;
  json: boolean;
  fromTs?: number;
  help: boolean;
  rootDir?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--from') {
      const next = argv[++i];
      if (!next) throw new Error('--from requires a timestamp value');
      const n = Number(next);
      if (!Number.isFinite(n)) throw new Error(`--from must be a number, got: ${next}`);
      args.fromTs = n;
    } else if (a === '--root') {
      const next = argv[++i];
      if (!next) throw new Error('--root requires a path value');
      args.rootDir = next;
    } else if (a && !a.startsWith('-') && !args.sprintId) {
      args.sprintId = a;
    } else if (a) {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

export function helpText(): string {
  return [
    'ifleet tail <sprintId> [options]',
    '',
    'Stream events from a sprint event log.',
    '',
    'Options:',
    '  --json          Emit raw JSON instead of pretty-printed output',
    '  --from <ts>     Skip events older than the given epoch ms timestamp',
    '  --root <dir>    Override the events root directory (default: .omc/sprints)',
    '  -h, --help      Show this help',
  ].join('\n');
}

function colorForKind(kind: string): string {
  if (kind.startsWith('task.done')) return COLORS.green;
  if (kind.startsWith('task.failed') || kind === 'error') return COLORS.red;
  if (kind.startsWith('task.')) return COLORS.cyan;
  if (kind.includes('rateLimit')) return COLORS.yellow;
  if (kind.startsWith('sprint.')) return COLORS.magenta;
  return COLORS.blue;
}

export function formatEventLine(event: Event, useColor = true): string {
  const ts = new Date(event.ts).toISOString();
  const kind = event.kind;
  const color = useColor ? colorForKind(kind) : '';
  const reset = useColor ? COLORS.reset : '';
  const dim = useColor ? COLORS.dim : '';
  const parts: string[] = [];
  parts.push(`${dim}${ts}${reset}`);
  parts.push(`${color}${kind.padEnd(16)}${reset}`);
  if (event.taskId) parts.push(`task=${event.taskId}`);
  if (event.workerId) parts.push(`worker=${event.workerId}`);
  const payloadKeys = Object.keys(event.payload ?? {});
  if (payloadKeys.length > 0) {
    parts.push(JSON.stringify(event.payload));
  }
  return parts.join(' ');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n\n${helpText()}\n`);
    return 2;
  }

  if (args.help || !args.sprintId) {
    process.stdout.write(`${helpText()}\n`);
    return args.help ? 0 : 2;
  }

  const log = new FileEventLog({ rootDir: args.rootDir });
  const useColor = !args.json && process.stdout.isTTY === true;

  const handleExit = (): void => {
    process.exit(0);
  };
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  for await (const event of log.tail(args.sprintId, { fromTs: args.fromTs })) {
    if (args.json) {
      process.stdout.write(JSON.stringify(event) + '\n');
    } else {
      process.stdout.write(formatEventLine(event, useColor) + '\n');
    }
  }
  return 0;
}

const isDirectRun = (): boolean => {
  if (!process.argv[1]) return false;
  const entry = process.argv[1];
  return entry.endsWith('tail-cli.ts') || entry.endsWith('tail-cli.js');
};

if (isDirectRun()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`fatal: ${msg}\n`);
      process.exit(1);
    },
  );
}
