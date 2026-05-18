import { randomUUID } from 'node:crypto';
import { claudeChildEnv, wrapBriefAsData } from './claude-env.ts';
import { runStreaming, type SpawnLike } from './spawn-runner.ts';
import {
  categorizeRateLimitError,
  type SpawnHandle,
  type SpawnOpts,
  type WorkerAdapter,
  type WorkerEvent,
} from './types.ts';

const WORKER_INSTRUCTION =
  `You are an IFleet worker. Execute the user-supplied task brief that ` +
  `follows. The brief is the task description; complete it on the current ` +
  `working tree. Open a PR when finished.`;

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
      const args = buildClaudeArgs(opts, sessionId);

      let textBuffer = '';
      let totalCostUsd: number | undefined;
      let finalText = '';

      const handle = runStreaming({
        command: binary,
        args,
        cwd: opts.workingDir,
        env: claudeChildEnv(),
        signal: opts.signal,
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
          });
        },
        finalize: ({ startedAt, endedAt, sessionId: capturedSessionId }) => ({
          ok: true,
          text: finalText !== '' ? finalText : textBuffer,
          sessionId: capturedSessionId !== '' ? capturedSessionId : sessionId,
          totalCostUsd,
          durationMs: endedAt - startedAt,
        }),
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

function buildClaudeArgs(opts: SpawnOpts, sessionId: string): string[] {
  // Wrap the user-controlled brief in an explicit DATA block so a malicious
  // brief cannot escape into the instruction layer (prompt injection → RCE
  // via the worker's tool permissions). The worker still executes the brief
  // as a task — Claude is instructed to refuse role-switch / "ignore the
  // above" patterns inside the block.
  const wrapped = wrapBriefAsData(WORKER_INSTRUCTION, opts.brief);
  const args = [
    '-p',
    wrapped,
    '--model',
    opts.model,
    '--permission-mode',
    'auto',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // --bare intentionally omitted: it disables keychain/OAuth auth, which breaks
    // Claude Max accounts. Phase B can revisit once ANTHROPIC_API_KEY support lands.
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
  return args;
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
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number;
  error?: string;
}

function parseClaudeEvent(
  raw: unknown,
  emit: (e: WorkerEvent) => void,
  onTextDelta: (text: string) => void,
  onCost: (cost: number | undefined) => void,
  onFinalText: (text: string) => void,
): void {
  if (typeof raw !== 'object' || raw === null) return;
  const evt = raw as ClaudeStreamEvent;
  const type = evt.type;
  if (type === undefined) return;

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
