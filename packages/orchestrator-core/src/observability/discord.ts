import type { Event } from './types.js';

export const DISCORD_CHUNK_LIMIT = 1900;
export const BUFFER_FLUSH_MS = 800;

interface TaskState {
  taskId: string;
  status: 'in_flight' | 'done' | 'failed';
  workerId?: string;
  startedAt?: number;
  finishedAt?: number;
  title?: string;
}

interface RateLimitState {
  workerId: string;
  remaining?: number;
  limit?: number;
  reset?: number;
  pressure?: 'low' | 'medium' | 'high';
}

interface ErrorEntry {
  ts: number;
  taskId?: string;
  workerId?: string;
  message: string;
}

export interface StatusCardState {
  sprintId: string;
  mode?: string;
  startedAt?: number;
  tasks: Map<string, TaskState>;
  rateLimits: Map<string, RateLimitState>;
  errors: ErrorEntry[];
}

export function reduceEvents(sprintId: string, events: Event[]): StatusCardState {
  const state: StatusCardState = {
    sprintId,
    tasks: new Map(),
    rateLimits: new Map(),
    errors: [],
  };

  for (const event of events) {
    switch (event.kind) {
      case 'sprint.start': {
        state.startedAt = event.ts;
        const mode = event.payload?.['mode'];
        if (typeof mode === 'string') state.mode = mode;
        break;
      }
      case 'task.picked':
      case 'task.start': {
        const taskId = event.taskId ?? '';
        if (!taskId) break;
        const prev = state.tasks.get(taskId);
        state.tasks.set(taskId, {
          taskId,
          status: 'in_flight',
          workerId: event.workerId ?? prev?.workerId,
          startedAt: prev?.startedAt ?? event.ts,
          title: (event.payload?.['title'] as string | undefined) ?? prev?.title,
        });
        break;
      }
      case 'task.done': {
        const taskId = event.taskId ?? '';
        if (!taskId) break;
        const prev = state.tasks.get(taskId);
        state.tasks.set(taskId, {
          taskId,
          status: 'done',
          workerId: event.workerId ?? prev?.workerId,
          startedAt: prev?.startedAt,
          finishedAt: event.ts,
          title: prev?.title,
        });
        break;
      }
      case 'task.failed': {
        const taskId = event.taskId ?? '';
        if (!taskId) break;
        const prev = state.tasks.get(taskId);
        state.tasks.set(taskId, {
          taskId,
          status: 'failed',
          workerId: event.workerId ?? prev?.workerId,
          startedAt: prev?.startedAt,
          finishedAt: event.ts,
          title: prev?.title,
        });
        const message = String(event.payload?.['error'] ?? 'task failed');
        state.errors.push({
          ts: event.ts,
          taskId,
          workerId: event.workerId,
          message,
        });
        break;
      }
      case 'worker.rateLimit':
      case 'rateLimit': {
        const workerId = event.workerId ?? (event.payload?.['workerId'] as string | undefined);
        if (!workerId) break;
        const remaining = numOrUndef(event.payload?.['remaining']);
        const limit = numOrUndef(event.payload?.['limit']);
        const reset = numOrUndef(event.payload?.['reset']);
        let pressure: RateLimitState['pressure'];
        if (remaining !== undefined && limit !== undefined && limit > 0) {
          const ratio = remaining / limit;
          if (ratio < 0.1) pressure = 'high';
          else if (ratio < 0.4) pressure = 'medium';
          else pressure = 'low';
        }
        state.rateLimits.set(workerId, { workerId, remaining, limit, reset, pressure });
        break;
      }
      case 'error': {
        state.errors.push({
          ts: event.ts,
          taskId: event.taskId,
          workerId: event.workerId,
          message: String(event.payload?.['message'] ?? 'error'),
        });
        break;
      }
      default:
        break;
    }
  }

  return state;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function formatStatusCard(sprintId: string, events: Event[], now = Date.now()): string[] {
  const state = reduceEvents(sprintId, events);
  const lines: string[] = [];

  const elapsedMs = state.startedAt ? now - state.startedAt : 0;
  lines.push(`**Sprint \`${state.sprintId}\`**`);
  const headerBits: string[] = [];
  if (state.mode) headerBits.push(`mode: \`${state.mode}\``);
  if (state.startedAt) headerBits.push(`elapsed: ${formatElapsed(elapsedMs)}`);
  if (headerBits.length) lines.push(headerBits.join(' · '));
  lines.push('');

  const done: TaskState[] = [];
  const inFlight: TaskState[] = [];
  const failed: TaskState[] = [];
  for (const t of state.tasks.values()) {
    if (t.status === 'done') done.push(t);
    else if (t.status === 'in_flight') inFlight.push(t);
    else if (t.status === 'failed') failed.push(t);
  }

  lines.push(`**Tasks done (${done.length})**`);
  if (done.length === 0) lines.push('_none yet_');
  else for (const t of done) lines.push(`- ✅ \`${t.taskId}\`${t.title ? ` — ${t.title}` : ''}`);
  lines.push('');

  lines.push(`**Tasks in flight (${inFlight.length})**`);
  if (inFlight.length === 0) lines.push('_idle_');
  else
    for (const t of inFlight)
      lines.push(
        `- ▶ \`${t.taskId}\`${t.workerId ? ` @${t.workerId}` : ''}${
          t.title ? ` — ${t.title}` : ''
        }`,
      );
  lines.push('');

  if (state.rateLimits.size > 0) {
    lines.push('**Rate limit pressure**');
    for (const rl of state.rateLimits.values()) {
      const ratio =
        rl.remaining !== undefined && rl.limit ? `${rl.remaining}/${rl.limit}` : 'n/a';
      const pressure = rl.pressure ?? 'unknown';
      lines.push(`- \`${rl.workerId}\`: ${pressure} (${ratio})`);
    }
    lines.push('');
  }

  const allErrors = [...failed.map(failedToError), ...state.errors];
  if (allErrors.length > 0) {
    lines.push(`**Errors (${allErrors.length})**`);
    for (const e of allErrors.slice(-10)) {
      const where = e.taskId ? ` \`${e.taskId}\`` : '';
      lines.push(`- ⚠️${where} ${truncate(e.message, 200)}`);
    }
  }

  return chunkLines(lines, DISCORD_CHUNK_LIMIT);
}

function failedToError(t: TaskState): ErrorEntry {
  return {
    ts: t.finishedAt ?? 0,
    taskId: t.taskId,
    workerId: t.workerId,
    message: `${t.taskId} failed`,
  };
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function chunkLines(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current.length === 0 ? line : current + '\n' + line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
    if (line.length <= limit) {
      current = line;
    } else {
      // hard-split a single oversized line
      let remaining = line;
      while (remaining.length > limit) {
        chunks.push(remaining.slice(0, limit));
        remaining = remaining.slice(limit);
      }
      current = remaining;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface BufferedFormatter {
  push(event: Event): void;
  flush(): string[];
  close(): void;
}

export function createBufferedFormatter(
  sprintId: string,
  emit: (chunks: string[]) => void,
  windowMs = BUFFER_FLUSH_MS,
): BufferedFormatter {
  let buffered: Event[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const doFlush = (): string[] => {
    if (buffered.length === 0) return [];
    const chunks = formatStatusCard(sprintId, buffered);
    buffered = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return chunks;
  };

  // Protect the buffering pipeline from emit() throwing (e.g. webhook network error).
  const safeEmit = (chunks: string[]): void => {
    try {
      emit(chunks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[discord-buffer] emit failed: ${msg}`);
    }
  };

  return {
    push(event: Event): void {
      if (closed) return;
      buffered.push(event);
      if (timer === null) {
        timer = setTimeout(() => {
          const chunks = doFlush();
          if (chunks.length > 0) safeEmit(chunks);
        }, windowMs);
      }
    },
    flush(): string[] {
      const chunks = doFlush();
      if (chunks.length > 0) safeEmit(chunks);
      return chunks;
    },
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
