import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStreaming, type SpawnLike } from './spawn-runner.js';
import {
  categorizeRateLimitError,
  type SpawnHandle,
  type SpawnOpts,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerResult,
} from './types.js';

// Process-env *allowlist* for the `codex` subprocess. Without this the child
// inherited the full parent `process.env` (GITHUB_TOKEN, DISCORD_BOT_TOKEN,
// IFLEET_HMAC_SECRET, ANTHROPIC_API_KEY, …), so a prompt-injected codex run
// could exfiltrate every secret by simply echoing it. Mirrors
// `claudeChildEnv()` in `claude-env.ts`; `git` subprocesses in
// `src/repos/manager.ts` still get the real env on a different code path.
// CODEX_HOME points at the codex config/auth dir (default ~/.codex), where the
// ChatGPT-login credential lives — that's the auth codex actually needs, so no
// API key is required in the common case. (AUDIT-IFleet-046c37f4)
const CODEX_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'NODE_ENV',
  'LANG',
  'LC_ALL',
  'CODEX_HOME',
] as const;

export interface CodexChildEnvOptions {
  /**
   * Pass true only when codex is authenticated via OPENAI_API_KEY rather than
   * the ChatGPT login stored under CODEX_HOME (~/.codex). The IFleet default is
   * subscription/ChatGPT auth, which does NOT need the key — omitting it from
   * the child env closes the prompt-injection exfiltration vector.
   */
  includeApiKey?: boolean;
}

/**
 * Build the scoped child env for a `codex` subprocess. Only allowlisted keys
 * are forwarded; every secret outside the allowlist is dropped.
 */
export function codexChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: CodexChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === 'string') out[key] = value;
  }
  if (opts.includeApiKey) {
    const apiKey = source['OPENAI_API_KEY'];
    if (typeof apiKey === 'string') out['OPENAI_API_KEY'] = apiKey;
  }
  return out;
}

export interface CodexAdapterOptions {
  binary?: string;
  spawnImpl?: SpawnLike;
  tmpRoot?: string;
  /** Forward OPENAI_API_KEY into the codex child env (default: false). */
  includeApiKey?: boolean;
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
      // Terminal signals observed on the event stream. `finalize()` used to
      // hardcode `ok: true`, so a rate-limited or errored codex run was
      // reported as success and silently dropped instead of being re-queued /
      // routed to the blocked path. Track them and classify the result.
      // (AUDIT-IFleet-fcec2264)
      let sawRateLimit = false;
      let sawError = false;
      let errorMessage = '';

      const readFinalAndCleanup = (): string => {
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
        return finalText;
      };

      const classifyResult = (durationMs: number): WorkerResult => {
        const text = readFinalAndCleanup();
        if (sawRateLimit) {
          // A rate limit / transient server error is NOT a failed task — the
          // pipeline should re-queue it for a later window (mandatory rule 5).
          return { ok: false, text, sessionId: threadId, durationMs, rateLimited: true };
        }
        if (sawError) {
          // Hard error (auth, billing, invalid request, …). Surface the codex
          // message as `text` so the operator/queue sees why it failed.
          return {
            ok: false,
            text: errorMessage !== '' ? errorMessage : text,
            sessionId: threadId,
            durationMs,
          };
        }
        return { ok: true, text, sessionId: threadId, durationMs };
      };

      const handle = runStreaming({
        command: binary,
        args,
        cwd: opts.workingDir,
        env: codexChildEnv(process.env, { includeApiKey: adapterOpts.includeApiKey ?? false }),
        signal: opts.signal,
        spawnImpl: adapterOpts.spawnImpl,
        parseLine: (line, emit) => {
          const evt = safeJsonParse(line);
          if (evt === undefined) return;
          // Observe terminal events as they are emitted so finalize/classifyExit
          // can downgrade a non-clean run from the old hardcoded ok:true.
          parseCodexEvent(evt, (e) => {
            if (e.kind === 'rate_limit') {
              sawRateLimit = true;
            } else if (e.kind === 'error') {
              sawError = true;
              if (errorMessage === '') errorMessage = e.message;
            }
            emit(e);
          }, {
            onThreadId: (id) => {
              if (threadId === '') threadId = id;
            },
            onProgress: (text) => {
              progressBuffer += text;
            },
          });
        },
        finalize: ({ startedAt, endedAt }) => classifyResult(endedAt - startedAt),
        // Codex can emit a rate-limit / server-error event and then exit
        // non-zero. Reclassify that as a result (ok:false, rateLimited) so the
        // pipeline re-queues instead of treating it as a crash. A non-zero exit
        // with no terminal event observed is a genuine crash → return undefined.
        classifyExit: ({ startedAt, endedAt }) => {
          if (!sawRateLimit && !sawError) return undefined;
          return classifyResult(endedAt - startedAt);
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

function buildCodexArgs(opts: SpawnOpts, lastMessagePath: string): string[] {
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
      opts.brief,
    ];
  }
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    lastMessagePath,
    opts.brief,
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
