import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapBriefAsData } from './claude-env.ts';
import { runStreaming, type SpawnLike } from './spawn-runner.ts';
import {
  categorizeRateLimitError,
  type SpawnHandle,
  type SpawnOpts,
  type WorkerAdapter,
  type WorkerEvent,
} from './types.ts';

export interface CodexAdapterOptions {
  binary?: string;
  spawnImpl?: SpawnLike;
  tmpRoot?: string;
}

export function createCodexAdapter(adapterOpts: CodexAdapterOptions = {}): WorkerAdapter {
  const binary = adapterOpts.binary ?? 'codex';
  return {
    provider: 'codex',
    spawn(opts: SpawnOpts): SpawnHandle {
      const tmpRoot = adapterOpts.tmpRoot ?? tmpdir();
      const tmpDir = mkdtempSync(join(tmpRoot, 'ifleet-codex-'));
      const lastMessagePath = join(tmpDir, 'last-message.txt');

      const args = buildCodexArgs(opts, lastMessagePath);

      let threadId = '';
      let progressBuffer = '';

      const handle = runStreaming({
        command: binary,
        args,
        cwd: opts.workingDir,
        signal: opts.signal,
        spawnImpl: adapterOpts.spawnImpl,
        parseLine: (line, emit) => {
          const evt = safeJsonParse(line);
          if (evt === undefined) return;
          parseCodexEvent(evt, emit, {
            onThreadId: (id) => {
              if (threadId === '') threadId = id;
            },
            onProgress: (text) => {
              progressBuffer += text;
            },
          });
        },
        finalize: ({ startedAt, endedAt }) => {
          let finalText = progressBuffer;
          try {
            finalText = readFileSync(lastMessagePath, 'utf8');
          } catch {
            // tmpfile may not exist if run ended early
          }
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            // best effort
          }
          return {
            ok: true,
            text: finalText,
            sessionId: threadId,
            durationMs: endedAt - startedAt,
          };
        },
      });

      return {
        pid: handle.pid,
        sessionId: handle.sessionId,
        events: handle.events,
        cancel: handle.cancel,
        result: handle.result,
      };
    },
  };
}

const CODEX_WORKER_INSTRUCTION =
  `You are a Codex worker. Execute the user-supplied task brief that follows. ` +
  `Only read and write files within the current working directory.`;

function buildCodexArgs(opts: SpawnOpts, lastMessagePath: string): string[] {
  // Wrap the brief in a DATA block (defense-in-depth). The codex CLI is
  // invoked via spawn with shell:false so there is no active shell-injection
  // vector, but wrapping prevents prompt-injection from escaping the data
  // layer into the instruction layer — matching the claude adapter's posture.
  const wrapped = opts.trustedBrief ? opts.brief : wrapBriefAsData(CODEX_WORKER_INSTRUCTION, opts.brief);
  if (opts.sessionId !== undefined && opts.sessionId !== '') {
    return [
      'exec',
      'resume',
      opts.sessionId,
      '--json',
      '--sandbox',
      'workspace-write',
      '--output-last-message',
      lastMessagePath,
      wrapped,
    ];
  }
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    lastMessagePath,
    wrapped,
  ];
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

interface CodexEventCallbacks {
  onThreadId: (id: string) => void;
  onProgress: (text: string) => void;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  turn_id?: string;
  item?: {
    type?: string;
    name?: string;
    arguments?: unknown;
    input?: unknown;
    output?: unknown;
    text?: string;
    success?: boolean;
    is_error?: boolean;
  };
  error?: { message?: string; code?: string; status?: number; type?: string } | string;
  message?: string;
  status?: number;
}

function parseCodexEvent(raw: unknown, emit: (e: WorkerEvent) => void, cb: CodexEventCallbacks): void {
  if (typeof raw !== 'object' || raw === null) return;
  const evt = raw as CodexEvent;
  const type = evt.type;
  if (type === undefined) return;

  if (type === 'thread.started') {
    if (typeof evt.thread_id === 'string') {
      cb.onThreadId(evt.thread_id);
      emit({ kind: 'init', sessionId: evt.thread_id });
    }
    return;
  }

  if (type === 'turn.started' || type === 'turn.completed') {
    return;
  }

  if (type === 'item.created' || type === 'item.updated' || type === 'item.completed') {
    const item = evt.item;
    if (!item || typeof item !== 'object') return;
    const itemType = item.type;
    if (itemType === 'assistant_message' || itemType === 'agent_message' || itemType === 'message') {
      if (typeof item.text === 'string' && type === 'item.completed') {
        cb.onProgress(item.text);
        emit({ kind: 'progress', text: item.text });
      }
      return;
    }
    if (itemType === 'tool_call' || itemType === 'function_call' || itemType === 'command_execution') {
      if (type === 'item.created' && typeof item.name === 'string') {
        emit({ kind: 'tool_use', name: item.name, input: item.arguments ?? item.input });
      }
      if (type === 'item.completed') {
        const ok = item.success !== false && item.is_error !== true;
        emit({ kind: 'tool_result', ok, output: item.output });
      }
      return;
    }
    return;
  }

  if (type === 'error') {
    const errObj = evt.error;
    const message = typeof errObj === 'string'
      ? errObj
      : errObj?.message ?? evt.message ?? 'unknown error';
    const status = typeof errObj === 'object' && errObj !== null ? errObj.status : evt.status;
    const category = categorizeRateLimitError(status, message);
    if (category === 'rate_limit' || category === 'server_error') {
      emit({
        kind: 'rate_limit',
        retryDelayMs: 0,
        category,
        errorStatus: status,
        error: message,
      });
      return;
    }
    emit({ kind: 'error', category, message });
  }
}
