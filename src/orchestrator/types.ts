export type SprintId = string & { readonly _brand: 'SprintId' };
export type TaskId = string & { readonly _brand: 'TaskId' };
export type WorkerId = string;

/**
 * How a sprint is operated by the orchestrator. Distinct from {@link SprintMode}
 * (which is per-task routing): `overnight` relaxes timeouts and retry caps for
 * long unattended runs, `normal` is the daytime default.
 */
export type SprintOperatingMode = 'normal' | 'overnight';

// Per-task routing mode (`ralph` | `ulw` | `tdd` | `deslop` | `standard`) is
// hoisted into the contracts/routing type root and re-exported here so
// `orchestrator/types` import sites keep resolving. See contracts/routing.ts.
export type { SprintMode } from '@wahq/orchestrator-core/contracts/routing';

export type SprintState =
  | { kind: 'queued' }
  | { kind: 'planning' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'paused'; at: number; reason: string; startedAt?: number }
  | { kind: 'cancelled'; reason: string; at: number }
  | { kind: 'completed'; at: number; prs: string[] }
  | { kind: 'failed'; at: number; error: string };

export interface SprintRecord {
  id: SprintId;
  mode: SprintOperatingMode;
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
  | { kind: 'cancelled'; at: number; reason: string }
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
  /**
   * Agent identity for trace tagging (e.g. "architect", "plan-reviewer",
   * "diff-reviewer", "editor", "doctor", "worker"). When present, used as
   * the Langfuse trace name; otherwise traces default to "claude-cli".
   * Optional + backwards-compatible — pipeline callers can adopt incrementally.
   */
  agentName?: string;
  /**
   * Sprint-level Langfuse trace ID set by SprintManager. Injected into the
   * child subprocess env as LANGFUSE_PARENT_TRACE_ID so all role spawns
   * (architect, editor, verifier, reviewer, doctor, drift, bandit) attach
   * to a single sprint trace tree. If LANGFUSE_PARENT_TRACE_ID is already
   * present in the orchestrator process env (manual debugging), that value
   * takes precedence over this field — see claudeChildEnv().
   */
  parentTraceId?: string;
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
  totalCostUsd?: number;
  totalTokens?: number;
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
