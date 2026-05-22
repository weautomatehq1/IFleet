export type WorkerProvider = 'claude' | 'codex';

export interface WorkerAdapter {
  readonly provider: WorkerProvider;
  spawn(opts: SpawnOpts): SpawnHandle;
}

export interface SpawnOpts {
  taskId: string;
  brief: string;
  model: string;
  workingDir: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Passed as --system-prompt to override CLAUDE.md for autonomous worker roles. */
  systemPrompt?: string;
  /**
   * When true, pass `brief` directly to `-p` without the anti-injection
   * DATA wrapper. Use for trusted pipeline content (e.g. architect plan +
   * editor brief) where wrapping as "DATA, not instructions" would prevent
   * Claude from acting on the plan.
   */
  trustedBrief?: boolean;
  /**
   * Named Claude login profile (created via `claude auth login --profile <name>`).
   * Passed to the CLI as `--profile <name>`. Omit or set to `"default"` to use the
   * default profile (the `--profile` flag is suppressed in that case).
   */
  authProfile?: string;
}

export interface SpawnHandle {
  readonly pid: number;
  readonly sessionId: Promise<string>;
  readonly events: AsyncIterable<WorkerEvent>;
  cancel(): Promise<void>;
  result: Promise<WorkerResult>;
}

export type WorkerEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'tool_result'; ok: boolean; output: unknown }
  | { kind: 'rate_limit'; retryDelayMs: number; category: RateLimitCategory; attempt?: number; maxRetries?: number; errorStatus?: number; error?: string }
  | { kind: 'error'; category: string; message: string };

export type RateLimitCategory =
  | 'rate_limit'
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'invalid_request'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';

export interface WorkerResult {
  ok: boolean;
  text: string;
  sessionId: string;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export class WorkerCrashError extends Error {
  override readonly name = 'WorkerCrashError';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  constructor(
    message: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
  ) {
    super(message);
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrTail = stderrTail;
  }
}

export function categorizeRateLimitError(status: number | undefined, raw: string | undefined): RateLimitCategory {
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'authentication_failed';
  if (status === 403) {
    if (raw && /oauth.*org/i.test(raw)) return 'oauth_org_not_allowed';
    return 'authentication_failed';
  }
  if (status === 402) return 'billing_error';
  if (status === 400) {
    if (raw && /max.*output.*tokens/i.test(raw)) return 'max_output_tokens';
    return 'invalid_request';
  }
  if (status !== undefined && status >= 500 && status < 600) return 'server_error';
  if (raw) {
    if (/rate.?limit/i.test(raw)) return 'rate_limit';
    if (/auth/i.test(raw)) return 'authentication_failed';
    if (/billing|payment/i.test(raw)) return 'billing_error';
    if (/max.*output.*tokens/i.test(raw)) return 'max_output_tokens';
  }
  return 'unknown';
}
