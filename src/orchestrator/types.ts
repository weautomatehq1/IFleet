export type SprintId = string & { readonly _brand: 'SprintId' };
export type TaskId = string & { readonly _brand: 'TaskId' };
export type WorkerId = string;

export type SprintMode = 'normal' | 'overnight';

export type SprintState =
  | { kind: 'queued' }
  | { kind: 'planning' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'cancelled'; reason: string; at: number }
  | { kind: 'completed'; at: number; prs: string[] }
  | { kind: 'failed'; at: number; error: string };

export interface SprintRecord {
  id: SprintId;
  mode: SprintMode;
  goal: string;
  tasks: TaskId[];
  state: SprintState;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorEvent {
  ts: number;
  sprintId: SprintId;
  taskId?: TaskId;
  workerId?: WorkerId;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RateLimitSnapshot {
  workerId: WorkerId;
  tokensRemaining: number;
  resetAt: number;
  pressure: number;
  observedAt: number;
}

export type TaskState =
  | { kind: 'pending' }
  | { kind: 'assigned'; workerId: WorkerId; at: number }
  | { kind: 'running'; workerId: WorkerId; startedAt: number }
  | { kind: 'completed'; at: number; pr?: string }
  | { kind: 'failed'; at: number; error: string };

export interface TaskRecord {
  id: TaskId;
  sprintId: SprintId;
  brief: string;
  state: TaskState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  requiredCapabilities?: string[];
}

export interface SpawnOpts {
  model?: string;
  permissionMode?: string;
  timeoutMs?: number;
}

export interface SpawnHandle {
  workerId: WorkerId;
  taskId: TaskId;
  pid?: number;
  cancel: () => Promise<void>;
  done: Promise<SpawnResult>;
}

export interface SpawnResult {
  taskId: TaskId;
  workerId: WorkerId;
  exitCode: number;
  pr?: string;
  error?: string;
}

export interface WorkerAdapter {
  spawn(taskId: TaskId, brief: string, opts: SpawnOpts): Promise<SpawnHandle>;
}

export interface RateLimitHeaders {
  tokensRemaining: number;
  tokensLimit: number;
  resetAt: number;
}

export interface WorkerConfig {
  id: WorkerId;
  provider: string;
  tier?: string;
  authProfile?: string;
  permissionMode?: string;
  models?: string[];
  maxConcurrent: number;
  enabled: boolean;
  notes?: string;
}

export const newSprintId = (raw: string): SprintId => raw as SprintId;
export const newTaskId = (raw: string): TaskId => raw as TaskId;
