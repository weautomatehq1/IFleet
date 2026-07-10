import { randomUUID } from 'node:crypto';
import { claudeChildEnv, wrapBriefAsData } from './claude-env.js';
import { runStreaming, type SpawnLike } from './spawn-runner.js';
import {
  categorizeRateLimitError,
  type SpawnHandle,
  type SpawnOpts,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerResult,
} from './types.js';

const WORKER_INSTRUCTION =
  `You are an IFleet worker. Execute the user-supplied task brief that ` +
  `follows. The brief is the task description; complete it on the current ` +
  `working tree. IMPORTANT: only read and write files within the current ` +
  `working directory (process.cwd()). Do NOT navigate to parent directories, ` +
  `sibling repos, or any path outside the worktree you were started in.`;

export interface ClaudeAdapterOptions {
  binary?: string;
  spawnImpl?: SpawnLike;
}

export function createClaudeAdapter(adapterOpts: ClaudeAdapterOptions = {}): WorkerAdapter {
  const binary = adapterOpts.binary ?? 'claude';
  return {
    provider: 'claude',
    spawn(opts: SpawnOpts): SpawnHandle {
      // --session-id requires a UUID; never fall back to taskId (which is not a UUID).
      const sessionId = opts.sessionId ?? randomUUID();
      const { args, stdinBrief } = buildClaudeArgs(opts, sessionId, opts.trustedBrief ?? false);

      let textBuffer = '';
      let totalCostUsd: number | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let finalText = '';
      let rateLimited = false;
      let rateLimitResetsAt: number | undefined;

      const handle = runStreaming({
        command: binary,
        args,
        cwd: opts.workingDir,
        env: claudeChildEnv(process.env, { parentTraceId: opts.parentTraceId }),
        signal: opts.signal,
        stdin: stdinBrief,
        spawnImpl: adapterOpts.spawnImpl,
        parseLine: (line, emit) => {
          const evt = safeJsonParse(line);
          if (evt === undefined) return;
          parseClaudeEvent(evt, emit, (delta) => {
            textBuffer += delta;
          }, (cost) => {
            if (typeof cost === 'number') totalCostUsd = cost;
          }, (text) => {
            finalText = text;
          }, (tokens) => {
            inputTokens = tokens.inputTokens;
            outputTokens = tokens.outputTokens;
          }, (resetsAt) => {
            rateLimited = true;
            if (typeof resetsAt === 'number') rateLimitResetsAt = resetsAt;
          });
        },
        finalize: ({ startedAt, endedAt, sessionId: capturedSessionId, stderrTail }) => {
          if (stderrTail) console.warn('[claude] stderr tail:', stderrTail.slice(0, 500));
          return {
            ok: true,
            text: finalText !== '' ? finalText : textBuffer,
            sessionId: capturedSessionId !== '' ? capturedSessionId : sessionId,
            totalCostUsd,
            inputTokens,
            outputTokens,
            durationMs: endedAt - startedAt,
          };
        },
        // A 429 makes the CLI exit non-zero AFTER emitting a rate-limit event.
        // Reclassify that as a result (ok:false, rateLimited:true) so the
        // pipeline can re-queue the task instead of treating it as a crash.
        classifyExit: ({ startedAt, endedAt, sessionId: capturedSessionId }) => {
          if (!rateLimited) return undefined;
          const result: WorkerResult = {
            ok: false,
            text: finalText !== '' ? finalText : textBuffer,
            sessionId: capturedSessionId !== '' ? capturedSessionId : sessionId,
            totalCostUsd,
            inputTokens,
            outputTokens,
            durationMs: endedAt - startedAt,
            rateLimited: true,
          };
          if (rateLimitResetsAt !== undefined) result.rateLimitResetsAt = rateLimitResetsAt;
          return result;
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

function buildClaudeArgs(
  opts: SpawnOpts,
  sessionId: string,
  trustedBrief: boolean,
): { args: string[]; stdinBrief: string } {
  // For trusted pipeline content (editor, doctor), pass the brief directly so
  // Claude can follow the architect plan as instructions. For untrusted user
  // input (architect phase), wrap in a DATA block to block prompt injection.
  const stdinBrief = trustedBrief ? opts.brief : wrapBriefAsData(WORKER_INSTRUCTION, opts.brief);
  // Brief is delivered via stdin so it never appears in `ps aux` / /proc/*/cmdline.
  const args = [
    '--model',
    opts.model,
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // --bare intentionally omitted: it disables keychain/OAuth auth required for Claude Max.
  ];
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }
  if (opts.authProfile !== undefined && opts.authProfile !== '' && opts.authProfile !== 'default') {
    args.push('--profile', opts.authProfile);
  }
  if (opts.sessionId !== undefined && opts.sessionId !== '') {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--session-id', sessionId);
  }
  return { args, stdinBrief };
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown; id?: string }>;
  };
  delta?: { type?: string; text?: string };
  content?: unknown;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  error?: string;
  // Terminal rate-limit signalling (CLI emits these then exits non-zero):
  api_error_status?: number;
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

function parseClaudeEvent(
  raw: unknown,
  emit: (e: WorkerEvent) => void,
  onTextDelta: (text: string) => void,
  onCost: (cost: number | undefined) => void,
  onFinalText: (text: string) => void,
  onTokens?: (tokens: { inputTokens?: number; outputTokens?: number }) => void,
  onRateLimit?: (resetsAt: number | undefined) => void,
): void {
  if (typeof raw !== 'object' || raw === null) return;
  const evt = raw as ClaudeStreamEvent;
  const type = evt.type;
  if (type === undefined) return;

  // Terminal usage/rate-limit rejection — the CLI emits this then exits
  // non-zero. `resetsAt` is epoch seconds; normalize to ms.
  if (type === 'rate_limit_event' && evt.rate_limit_info?.status === 'rejected') {
    const resetsSec = evt.rate_limit_info.resetsAt;
    const resetsMs = typeof resetsSec === 'number' ? resetsSec * 1000 : undefined;
    emit({
      kind: 'rate_limit',
      retryDelayMs: resetsMs !== undefined ? Math.max(0, resetsMs - Date.now()) : 0,
      category: 'rate_limit',
    });
    onRateLimit?.(resetsMs);
    return;
  }

  if (type === 'system' && evt.subtype === 'init') {
    if (typeof evt.session_id === 'string') {
      emit({ kind: 'init', sessionId: evt.session_id });
    }
    return;
  }

  if (type === 'system' && evt.subtype === 'api_retry') {
    const category = categorizeRateLimitError(evt.error_status, evt.error);
    emit({
      kind: 'rate_limit',
      retryDelayMs: typeof evt.retry_delay_ms === 'number' ? evt.retry_delay_ms : 0,
      category,
      attempt: evt.attempt,
      maxRetries: evt.max_retries,
      errorStatus: evt.error_status,
      error: evt.error,
    });
    return;
  }

  if (type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        onTextDelta(block.text);
        emit({ kind: 'progress', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        emit({ kind: 'tool_use', name: block.name, input: block.input });
      }
    }
    return;
  }

  if (type === 'stream_event' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
    onTextDelta(evt.delta.text);
    emit({ kind: 'progress', text: evt.delta.text });
    return;
  }

  if (type === 'tool_result') {
    // Authoritative tool_result event: read `is_error` per the Claude
    // stream-json schema. The previously handled `type === 'user'` branch
    // tried to surface tool_result blocks nested inside user messages with
    // `ok: !block.input`, which has no semantic meaning — `block.input`
    // belongs to `tool_use`, not `tool_result`. The branch was dead code
    // for downstream consumers (no caller reads `tool_result` events from
    // user-typed messages) and is removed to avoid emitting events with a
    // bogus `ok` flag.
    emit({ kind: 'tool_result', ok: evt.is_error !== true, output: evt.content });
    return;
  }

  if (type === 'result') {
    onCost(evt.total_cost_usd);
    if (typeof evt.result === 'string') onFinalText(evt.result);
    if (onTokens && evt.usage) {
      onTokens({
        inputTokens: typeof evt.usage.input_tokens === 'number' ? evt.usage.input_tokens : undefined,
        outputTokens: typeof evt.usage.output_tokens === 'number' ? evt.usage.output_tokens : undefined,
      });
    }
    // A result flagged as a 429 (e.g. "You've hit your limit") is a rate
    // limit, not a successful turn — surface it so the exit is reclassified.
    if (evt.is_error === true && evt.api_error_status === 429) {
      emit({ kind: 'rate_limit', retryDelayMs: 0, category: 'rate_limit', errorStatus: 429 });
      onRateLimit?.(undefined);
    }
    return;
  }

  if (type === 'error') {
    emit({
      kind: 'error',
      category: typeof evt.subtype === 'string' ? evt.subtype : 'error',
      message: typeof evt.error === 'string' ? evt.error : JSON.stringify(evt),
    });
  }
}
